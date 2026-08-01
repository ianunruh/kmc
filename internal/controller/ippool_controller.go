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

// IPPoolReconciler reconciles IPPool objects.
type IPPoolReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=ippools,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=ippools/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=ippools/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch

func (r *IPPoolReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var obj kmcv1alpha1.IPPool
	if err := r.Get(ctx, req.NamespacedName, &obj); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	if !obj.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&obj, kmcv1alpha1.IPPoolFinalizer) {
			controllerutil.RemoveFinalizer(&obj, kmcv1alpha1.IPPoolFinalizer)
			if err := r.Update(ctx, &obj); err != nil {
				return ctrl.Result{}, err
			}
			logger.Info("removed finalizer")
		}
		return ctrl.Result{}, nil
	}

	if !controllerutil.ContainsFinalizer(&obj, kmcv1alpha1.IPPoolFinalizer) {
		controllerutil.AddFinalizer(&obj, kmcv1alpha1.IPPoolFinalizer)
		if err := r.Update(ctx, &obj); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if err := validateIPPoolSpec(&obj); err != nil {
		if statusErr := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.IPPool) {
			o.Status.Phase = kmcv1alpha1.IPPoolPhasePending
			o.Status.ObservedGeneration = o.Generation
			meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
				Type:               kmcv1alpha1.IPPoolConditionReady,
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

	if err := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.IPPool) {
		o.Status.Phase = kmcv1alpha1.IPPoolPhaseReady
		o.Status.ObservedGeneration = o.Generation
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.IPPoolConditionReady,
			Status:             metav1.ConditionTrue,
			Reason:             "Ready",
			Message:            fmt.Sprintf("pool %s ready", o.Spec.CIDR),
			ObservedGeneration: o.Generation,
		})
	}); err != nil {
		return ctrl.Result{}, err
	}

	return ctrl.Result{}, nil
}

func validateIPPoolSpec(obj *kmcv1alpha1.IPPool) error {
	if strings.TrimSpace(obj.Spec.MultusNetwork) == "" {
		return fmt.Errorf("multusNetwork is required")
	}
	network, err := ipam.ParseIPv4CIDR(obj.Spec.CIDR)
	if err != nil {
		return err
	}
	if gw := strings.TrimSpace(obj.Spec.Gateway); gw != "" {
		if err := ipam.ValidateIPv4Address(gw); err != nil {
			return fmt.Errorf("gateway: %w", err)
		}
		if !ipam.ContainsIPv4(network, gw) {
			return fmt.Errorf("gateway %s is outside cidr %s", gw, obj.Spec.CIDR)
		}
	}
	for _, d := range obj.Spec.DNS {
		if strings.TrimSpace(d) == "" {
			continue
		}
		if err := ipam.ValidateIPv4Address(d); err != nil {
			return fmt.Errorf("dns %q: %w", d, err)
		}
	}
	for _, ex := range obj.Spec.Exclude {
		if strings.TrimSpace(ex) == "" {
			continue
		}
		if err := ipam.ValidateIPv4Address(ex); err != nil {
			return fmt.Errorf("exclude %q: %w", ex, err)
		}
		if !ipam.ContainsIPv4(network, ex) {
			return fmt.Errorf("exclude %s is outside cidr %s", ex, obj.Spec.CIDR)
		}
	}
	for _, label := range []struct {
		name, val string
	}{
		{"start", obj.Spec.Start},
		{"end", obj.Spec.End},
	} {
		if strings.TrimSpace(label.val) == "" {
			continue
		}
		if err := ipam.ValidateIPv4Address(label.val); err != nil {
			return fmt.Errorf("%s: %w", label.name, err)
		}
		if !ipam.ContainsIPv4(network, label.val) {
			return fmt.Errorf("%s %s is outside cidr %s", label.name, label.val, obj.Spec.CIDR)
		}
	}
	if cni := obj.Spec.CNI; cni != nil {
		if strings.TrimSpace(cni.Type) == "" {
			return fmt.Errorf("cni.type is required when cni is set")
		}
		if strings.TrimSpace(cni.Bridge) == "" {
			return fmt.Errorf("cni.bridge is required when cni is set")
		}
		if cni.VLAN != nil {
			if err := ipam.ValidateVLANID(*cni.VLAN); err != nil {
				return fmt.Errorf("cni.vlan: %w", err)
			}
		}
	}
	return nil
}

func (r *IPPoolReconciler) patchStatus(ctx context.Context, obj *kmcv1alpha1.IPPool, mutate func(*kmcv1alpha1.IPPool)) error {
	latest := &kmcv1alpha1.IPPool{}
	if err := r.Get(ctx, client.ObjectKeyFromObject(obj), latest); err != nil {
		return err
	}
	before := latest.DeepCopy()
	mutate(latest)
	return r.Status().Patch(ctx, latest, client.MergeFrom(before))
}

// SetupWithManager registers the controller with the Manager.
func (r *IPPoolReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&kmcv1alpha1.IPPool{}).
		Named("ippool").
		Complete(r)
}
