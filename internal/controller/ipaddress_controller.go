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

// IPAddressReconciler reconciles IPAddress objects.
type IPAddressReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=ipaddresses,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=ipaddresses/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=ipaddresses/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch

func (r *IPAddressReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var obj kmcv1alpha1.IPAddress
	if err := r.Get(ctx, req.NamespacedName, &obj); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Deletion: drop finalizer (no external side effects in v1).
	if !obj.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&obj, kmcv1alpha1.IPAddressFinalizer) {
			controllerutil.RemoveFinalizer(&obj, kmcv1alpha1.IPAddressFinalizer)
			if err := r.Update(ctx, &obj); err != nil {
				return ctrl.Result{}, err
			}
			logger.Info("removed finalizer")
		}
		return ctrl.Result{}, nil
	}

	if !controllerutil.ContainsFinalizer(&obj, kmcv1alpha1.IPAddressFinalizer) {
		controllerutil.AddFinalizer(&obj, kmcv1alpha1.IPAddressFinalizer)
		if err := r.Update(ctx, &obj); err != nil {
			return ctrl.Result{}, err
		}
		// Requeue to continue after the write.
		return ctrl.Result{Requeue: true}, nil
	}

	if err := validateIPAddressSpec(&obj); err != nil {
		if statusErr := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.IPAddress) {
			o.Status.Phase = kmcv1alpha1.IPAddressPhasePending
			o.Status.ObservedGeneration = o.Generation
			meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
				Type:               kmcv1alpha1.IPAddressConditionReady,
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
		logger.Info("invalid spec", "error", err)
		return ctrl.Result{}, nil
	}

	if err := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.IPAddress) {
		o.Status.Phase = kmcv1alpha1.IPAddressPhaseBound
		o.Status.ObservedGeneration = o.Generation
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.IPAddressConditionReady,
			Status:             metav1.ConditionTrue,
			Reason:             "Bound",
			Message:            fmt.Sprintf("address %s/%d is bound", o.Spec.Address, o.Spec.PrefixLength),
			ObservedGeneration: o.Generation,
		})
	}); err != nil {
		return ctrl.Result{}, err
	}

	if r.Recorder != nil {
		r.Recorder.Eventf(&obj, corev1.EventTypeNormal, "Bound", "address %s bound", obj.Spec.Address)
	}
	logger.Info("bound", "address", obj.Spec.Address)
	return ctrl.Result{}, nil
}

func validateIPAddressSpec(obj *kmcv1alpha1.IPAddress) error {
	if err := ipam.ValidateIPv4Address(obj.Spec.Address); err != nil {
		return err
	}
	if err := ipam.ValidatePrefixLength(obj.Spec.PrefixLength); err != nil {
		return err
	}
	if strings.TrimSpace(obj.Spec.PoolRef.Kind) == "" {
		return fmt.Errorf("poolRef.kind is required")
	}
	if strings.TrimSpace(obj.Spec.PoolRef.Name) == "" {
		return fmt.Errorf("poolRef.name is required")
	}
	return nil
}

func (r *IPAddressReconciler) patchStatus(ctx context.Context, obj *kmcv1alpha1.IPAddress, mutate func(*kmcv1alpha1.IPAddress)) error {
	latest := &kmcv1alpha1.IPAddress{}
	if err := r.Get(ctx, client.ObjectKeyFromObject(obj), latest); err != nil {
		return err
	}
	before := latest.DeepCopy()
	mutate(latest)
	return r.Status().Patch(ctx, latest, client.MergeFrom(before))
}

// SetupWithManager registers the controller with the Manager.
func (r *IPAddressReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&kmcv1alpha1.IPAddress{}).
		Named("ipaddress").
		Complete(r)
}
