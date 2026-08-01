package controller

import (
	"context"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	"github.com/ianunruh/kmc/internal/ipam"
)

// VLANPoolReconciler reconciles VLANPool objects.
type VLANPoolReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=vlanpools,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=vlanpools/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=vlanpools/finalizers,verbs=update
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=vpcs,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch

func (r *VLANPoolReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var obj kmcv1alpha1.VLANPool
	if err := r.Get(ctx, req.NamespacedName, &obj); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	if !obj.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&obj, kmcv1alpha1.VLANPoolFinalizer) {
			controllerutil.RemoveFinalizer(&obj, kmcv1alpha1.VLANPoolFinalizer)
			if err := r.Update(ctx, &obj); err != nil {
				return ctrl.Result{}, err
			}
			logger.Info("removed finalizer")
		}
		return ctrl.Result{}, nil
	}

	if !controllerutil.ContainsFinalizer(&obj, kmcv1alpha1.VLANPoolFinalizer) {
		controllerutil.AddFinalizer(&obj, kmcv1alpha1.VLANPoolFinalizer)
		if err := r.Update(ctx, &obj); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if err := validateVLANPoolSpec(&obj); err != nil {
		if statusErr := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.VLANPool) {
			o.Status.Phase = kmcv1alpha1.VLANPoolPhasePending
			o.Status.ObservedGeneration = o.Generation
			meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
				Type:               kmcv1alpha1.VLANPoolConditionReady,
				Status:             metav1.ConditionFalse,
				Reason:             "InvalidSpec",
				Message:            err.Error(),
				ObservedGeneration: o.Generation,
			})
		}); statusErr != nil {
			return ctrl.Result{}, statusErr
		}
		if r.Recorder != nil {
			r.Recorder.Event(&obj, corev1.EventTypeWarning, "InvalidSpec", err.Error())
		}
		return ctrl.Result{}, nil
	}

	allocated, available, err := r.inventory(ctx, &obj)
	if err != nil {
		return ctrl.Result{}, err
	}

	if err := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.VLANPool) {
		o.Status.Phase = kmcv1alpha1.VLANPoolPhaseReady
		o.Status.Allocated = allocated
		o.Status.Available = available
		o.Status.ObservedGeneration = o.Generation
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.VLANPoolConditionReady,
			Status:             metav1.ConditionTrue,
			Reason:             "Ready",
			Message:            fmt.Sprintf("VLAN range %d–%d on bridge %s", o.Spec.Start, o.Spec.End, o.Spec.Bridge),
			ObservedGeneration: o.Generation,
		})
	}); err != nil {
		return ctrl.Result{}, err
	}

	return ctrl.Result{}, nil
}

func (r *VLANPoolReconciler) inventory(ctx context.Context, pool *kmcv1alpha1.VLANPool) (allocated, available int32, err error) {
	var vpcs kmcv1alpha1.VPCList
	if err := r.List(ctx, &vpcs); err != nil {
		return 0, 0, err
	}
	used := make(map[int32]struct{})
	for _, ex := range pool.Spec.Exclude {
		used[ex] = struct{}{}
	}
	var count int32
	for i := range vpcs.Items {
		v := &vpcs.Items[i]
		if v.Spec.VLANPoolRef.Name != pool.Name {
			continue
		}
		if v.Status.VLAN == 0 {
			continue
		}
		if _, ok := used[v.Status.VLAN]; !ok {
			// only count in-range for available math via used set size later
		}
		used[v.Status.VLAN] = struct{}{}
		count++
	}
	total := pool.Spec.End - pool.Spec.Start + 1
	// available = free slots in range not in used (exclude + allocated)
	var free int32
	for v := pool.Spec.Start; v <= pool.Spec.End; v++ {
		if _, ok := used[v]; !ok {
			free++
		}
	}
	_ = total
	return count, free, nil
}

func validateVLANPoolSpec(obj *kmcv1alpha1.VLANPool) error {
	if err := ipam.ValidateVLANRange(obj.Spec.Start, obj.Spec.End); err != nil {
		return err
	}
	if strings.TrimSpace(obj.Spec.Bridge) == "" {
		return fmt.Errorf("bridge is required")
	}
	if err := ipam.ValidateVLANExclude(obj.Spec.Start, obj.Spec.End, obj.Spec.Exclude); err != nil {
		return err
	}
	for _, d := range obj.Spec.DNS {
		if strings.TrimSpace(d) == "" {
			continue
		}
		if err := ipam.ValidateIPv4Address(d); err != nil {
			return fmt.Errorf("dns %q: %w", d, err)
		}
	}
	return nil
}

func (r *VLANPoolReconciler) patchStatus(ctx context.Context, obj *kmcv1alpha1.VLANPool, mutate func(*kmcv1alpha1.VLANPool)) error {
	latest := &kmcv1alpha1.VLANPool{}
	if err := r.Get(ctx, client.ObjectKeyFromObject(obj), latest); err != nil {
		return err
	}
	before := latest.DeepCopy()
	mutate(latest)
	return r.Status().Patch(ctx, latest, client.MergeFrom(before))
}

// SetupWithManager registers the controller with the Manager.
func (r *VLANPoolReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&kmcv1alpha1.VLANPool{}).
		Named("vlanpool").
		Complete(r)
}
