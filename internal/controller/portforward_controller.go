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
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	"github.com/ianunruh/kmc/internal/ipam"
)

// PortForwardReconciler reconciles PortForward objects.
// DNAT programming is projected by the Router controller.
type PortForwardReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=portforwards,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=portforwards/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=portforwards/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch

func (r *PortForwardReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var obj kmcv1alpha1.PortForward
	if err := r.Get(ctx, req.NamespacedName, &obj); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	if !obj.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&obj, kmcv1alpha1.PortForwardFinalizer) {
			controllerutil.RemoveFinalizer(&obj, kmcv1alpha1.PortForwardFinalizer)
			if err := r.Update(ctx, &obj); err != nil {
				return ctrl.Result{}, err
			}
			logger.Info("removed finalizer")
		}
		return ctrl.Result{}, nil
	}

	if !controllerutil.ContainsFinalizer(&obj, kmcv1alpha1.PortForwardFinalizer) {
		controllerutil.AddFinalizer(&obj, kmcv1alpha1.PortForwardFinalizer)
		if err := r.Update(ctx, &obj); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if err := validatePortForwardSpec(&obj); err != nil {
		if statusErr := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.PortForward) {
			o.Status.Phase = kmcv1alpha1.PortForwardPhaseError
			o.Status.Programmed = false
			o.Status.ObservedGeneration = o.Generation
			meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
				Type:               kmcv1alpha1.PortForwardConditionReady,
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

	routerName := ""
	if obj.Spec.RouterRef != nil {
		routerName = strings.TrimSpace(obj.Spec.RouterRef.Name)
	}
	prog, err := lookupRouterForVPC(ctx, r.Client, obj.Namespace, obj.Spec.VPCRef.Name, routerName)
	if err != nil {
		return ctrl.Result{}, err
	}

	programmed := false
	ready := false
	phase := kmcv1alpha1.PortForwardPhasePending
	reason := "WaitingForRouter"
	msg := "waiting for a Router attached to this VPC to program DNAT"
	if prog.Found {
		if prog.PolicyReady {
			programmed = true
			reason = "WaitingForAgent"
			msg = "projected into router policy; waiting for agent Ready"
		} else {
			reason = "WaitingForRouter"
			msg = "router " + prog.Name + " found; waiting for policy render"
		}
		if prog.AgentReady && programmed {
			ready = true
			phase = kmcv1alpha1.PortForwardPhaseReady
			reason = "Ready"
			msg = "router agent has programmed DNAT"
		}
	}

	if err := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.PortForward) {
		o.Status.Phase = phase
		o.Status.Programmed = programmed
		o.Status.ObservedGeneration = o.Generation
		status := metav1.ConditionFalse
		if ready {
			status = metav1.ConditionTrue
		}
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.PortForwardConditionReady,
			Status:             status,
			Reason:             reason,
			Message:            msg,
			ObservedGeneration: o.Generation,
		})
	}); err != nil {
		return ctrl.Result{}, err
	}

	return ctrl.Result{}, nil
}

func validatePortForwardSpec(obj *kmcv1alpha1.PortForward) error {
	if strings.TrimSpace(obj.Spec.VPCRef.Name) == "" {
		return fmt.Errorf("vpcRef.name is required")
	}
	if err := ipam.ValidateIPv4Address(obj.Spec.PublicAddress); err != nil {
		return fmt.Errorf("publicAddress: %w", err)
	}
	if err := ipam.ValidateIPv4Address(obj.Spec.PrivateAddress); err != nil {
		return fmt.Errorf("privateAddress: %w", err)
	}
	if err := ipam.ValidatePort(obj.Spec.PublicPort); err != nil {
		return fmt.Errorf("publicPort: %w", err)
	}
	if err := ipam.ValidatePort(obj.Spec.PrivatePort); err != nil {
		return fmt.Errorf("privatePort: %w", err)
	}
	if err := ipam.ValidateProtocolTCPUDP(obj.Spec.Protocol); err != nil {
		return err
	}
	return nil
}

func (r *PortForwardReconciler) patchStatus(ctx context.Context, obj *kmcv1alpha1.PortForward, mutate func(*kmcv1alpha1.PortForward)) error {
	latest := &kmcv1alpha1.PortForward{}
	if err := r.Get(ctx, client.ObjectKeyFromObject(obj), latest); err != nil {
		return err
	}
	before := latest.DeepCopy()
	mutate(latest)
	return r.Status().Patch(ctx, latest, client.MergeFrom(before))
}

// SetupWithManager registers the controller with the Manager.
func (r *PortForwardReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&kmcv1alpha1.PortForward{}).
		Watches(&kmcv1alpha1.Router{}, handler.EnqueueRequestsFromMapFunc(r.mapRouterToPortForwards)).
		Named("portforward").
		Complete(r)
}

func (r *PortForwardReconciler) mapRouterToPortForwards(ctx context.Context, obj client.Object) []reconcile.Request {
	rt, ok := obj.(*kmcv1alpha1.Router)
	if !ok {
		return nil
	}
	vpcs := map[string]struct{}{}
	for _, att := range rt.Spec.VPCs {
		if n := strings.TrimSpace(att.Name); n != "" {
			vpcs[n] = struct{}{}
		}
	}
	var list kmcv1alpha1.PortForwardList
	if err := r.List(ctx, &list, client.InNamespace(rt.Namespace)); err != nil {
		return nil
	}
	var reqs []reconcile.Request
	for i := range list.Items {
		pf := &list.Items[i]
		if pf.Spec.RouterRef != nil && strings.TrimSpace(pf.Spec.RouterRef.Name) == rt.Name {
			reqs = append(reqs, reconcile.Request{
				NamespacedName: types.NamespacedName{Namespace: pf.Namespace, Name: pf.Name},
			})
			continue
		}
		if _, ok := vpcs[strings.TrimSpace(pf.Spec.VPCRef.Name)]; ok {
			reqs = append(reqs, reconcile.Request{
				NamespacedName: types.NamespacedName{Namespace: pf.Namespace, Name: pf.Name},
			})
		}
	}
	return reqs
}
