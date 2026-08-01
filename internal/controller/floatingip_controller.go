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

// FloatingIPReconciler reconciles FloatingIP objects.
// Programming onto a router appliance is deferred to a future Router controller.
type FloatingIPReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=floatingips,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=floatingips/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=floatingips/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch

func (r *FloatingIPReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var obj kmcv1alpha1.FloatingIP
	if err := r.Get(ctx, req.NamespacedName, &obj); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	if !obj.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&obj, kmcv1alpha1.FloatingIPFinalizer) {
			controllerutil.RemoveFinalizer(&obj, kmcv1alpha1.FloatingIPFinalizer)
			if err := r.Update(ctx, &obj); err != nil {
				return ctrl.Result{}, err
			}
			logger.Info("removed finalizer")
		}
		return ctrl.Result{}, nil
	}

	if !controllerutil.ContainsFinalizer(&obj, kmcv1alpha1.FloatingIPFinalizer) {
		controllerutil.AddFinalizer(&obj, kmcv1alpha1.FloatingIPFinalizer)
		if err := r.Update(ctx, &obj); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if err := validateFloatingIPSpec(&obj); err != nil {
		if statusErr := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.FloatingIP) {
			o.Status.Phase = kmcv1alpha1.FloatingIPPhaseError
			o.Status.Programmed = false
			o.Status.ObservedGeneration = o.Generation
			meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
				Type:               kmcv1alpha1.FloatingIPConditionReady,
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

	addr := strings.TrimSpace(obj.Spec.Address)
	phase := kmcv1alpha1.FloatingIPPhaseHeld
	if strings.TrimSpace(obj.Spec.PrivateAddress) != "" {
		phase = kmcv1alpha1.FloatingIPPhaseAssociated
	}

	// Router CR not implemented: never Ready / Programmed.
	msg := "waiting for Router controller to program SNAT/DNAT (Router CR reserved, not implemented)"
	if obj.Spec.RouterRef == nil || strings.TrimSpace(obj.Spec.RouterRef.Name) == "" {
		msg = "routerRef is unset; FloatingIP will be programmed by a future Router controller"
	}

	if err := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.FloatingIP) {
		o.Status.Phase = phase
		if addr != "" {
			o.Status.Address = addr
		}
		o.Status.Programmed = false
		o.Status.ObservedGeneration = o.Generation
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.FloatingIPConditionReady,
			Status:             metav1.ConditionFalse,
			Reason:             "RouterNotImplemented",
			Message:            msg,
			ObservedGeneration: o.Generation,
		})
	}); err != nil {
		return ctrl.Result{}, err
	}

	return ctrl.Result{}, nil
}

func validateFloatingIPSpec(obj *kmcv1alpha1.FloatingIP) error {
	if strings.TrimSpace(obj.Spec.PoolRef.Kind) == "" {
		return fmt.Errorf("poolRef.kind is required")
	}
	if strings.TrimSpace(obj.Spec.PoolRef.Name) == "" {
		return fmt.Errorf("poolRef.name is required")
	}
	if strings.TrimSpace(obj.Spec.VPCRef.Name) == "" {
		return fmt.Errorf("vpcRef.name is required")
	}
	if addr := strings.TrimSpace(obj.Spec.Address); addr != "" {
		if err := ipam.ValidateIPv4Address(addr); err != nil {
			return fmt.Errorf("address: %w", err)
		}
	}
	if priv := strings.TrimSpace(obj.Spec.PrivateAddress); priv != "" {
		if err := ipam.ValidateIPv4Address(priv); err != nil {
			return fmt.Errorf("privateAddress: %w", err)
		}
	}
	return nil
}

func (r *FloatingIPReconciler) patchStatus(ctx context.Context, obj *kmcv1alpha1.FloatingIP, mutate func(*kmcv1alpha1.FloatingIP)) error {
	latest := &kmcv1alpha1.FloatingIP{}
	if err := r.Get(ctx, client.ObjectKeyFromObject(obj), latest); err != nil {
		return err
	}
	before := latest.DeepCopy()
	mutate(latest)
	return r.Status().Patch(ctx, latest, client.MergeFrom(before))
}

// SetupWithManager registers the controller with the Manager.
func (r *FloatingIPReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&kmcv1alpha1.FloatingIP{}).
		Named("floatingip").
		Complete(r)
}
