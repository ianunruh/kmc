package controller

import (
	"context"
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	rt "github.com/ianunruh/kmc/internal/router"
)

// RouterReconciler reconciles Router objects: control plane, policy, appliance.
type RouterReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder

	// ClusterPodCIDRs / ClusterServiceCIDRs are required for appliance cloud-init
	// (pod NIC routes so the agent can reach the apiserver).
	ClusterPodCIDRs     []string
	ClusterServiceCIDRs []string
	// APIServerURL overrides in-cluster discovery (optional).
	APIServerURL string
	// ClusterCAData is base64-encoded PEM (optional; defaults to in-cluster CA file).
	ClusterCAData string
	// SkipAppliance disables KubeVirt VM ensure (useful for unit tests).
	SkipAppliance bool
}

// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=routers,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=routers/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=routers/finalizers,verbs=update
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=vpcs,verbs=get;list;watch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=vpcs/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=ipaddresses,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=ippools,verbs=get;list;watch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=floatingips,verbs=get;list;watch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=portforwards,verbs=get;list;watch
// +kubebuilder:rbac:groups=k8s.cni.cncf.io,resources=network-attachment-definitions,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts/token,verbs=create
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=roles;rolebindings,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kubevirt.io,resources=virtualmachines,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch

func (r *RouterReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var obj kmcv1alpha1.Router
	if err := r.Get(ctx, req.NamespacedName, &obj); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	if !obj.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, &obj)
	}

	if !controllerutil.ContainsFinalizer(&obj, kmcv1alpha1.RouterFinalizer) {
		controllerutil.AddFinalizer(&obj, kmcv1alpha1.RouterFinalizer)
		if err := r.Update(ctx, &obj); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if err := validateRouterSpec(&obj); err != nil {
		_ = r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.Router) {
			o.Status.Phase = kmcv1alpha1.RouterPhaseError
			o.Status.ObservedGeneration = o.Generation
			meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
				Type:               kmcv1alpha1.RouterConditionReady,
				Status:             metav1.ConditionFalse,
				Reason:             "InvalidSpec",
				Message:            err.Error(),
				ObservedGeneration: o.Generation,
			})
		})
		if r.Recorder != nil {
			r.Recorder.Event(&obj, corev1.EventTypeWarning, "InvalidSpec", err.Error())
		}
		return ctrl.Result{}, nil
	}

	// Resolve interfaces + claim gateways + stamp VPCs
	ifaces, err := r.resolveAndClaimInterfaces(ctx, &obj)
	if err != nil {
		return r.fail(ctx, &obj, "InterfaceError", err.Error())
	}

	ext, err := r.resolveAndClaimExternal(ctx, &obj)
	if err != nil {
		return r.fail(ctx, &obj, "ExternalError", err.Error())
	}

	// Previous policy generation
	prevGen := obj.Status.PolicyGeneration
	var prevDoc *rt.PolicyDoc
	cmName := rt.ConfigMapName(obj.Name)
	var existingCM corev1.ConfigMap
	if err := r.Get(ctx, client.ObjectKey{Namespace: obj.Namespace, Name: cmName}, &existingCM); err == nil {
		prevDoc, _ = rt.ParsePolicyDoc(existingCM.Data[kmcv1alpha1.RouterPolicyDataKey])
		if prevDoc != nil && prevDoc.Metadata.Generation > 0 {
			prevGen = prevDoc.Metadata.Generation
		}
	}

	doc, err := r.buildPolicyDoc(ctx, &obj, ifaces, ext, prevGen)
	if err != nil {
		return r.fail(ctx, &obj, "PolicyBuildError", err.Error())
	}
	doc.Metadata.Generation = nextPolicyGeneration(prevDoc, doc)

	if err := r.ensureRouterControlPlane(ctx, &obj, doc); err != nil {
		return r.fail(ctx, &obj, "ControlPlaneError", err.Error())
	}

	// Agent status from CM
	var cm corev1.ConfigMap
	_ = r.Get(ctx, client.ObjectKey{Namespace: obj.Namespace, Name: cmName}, &cm)
	agentInfo := agentStatusFromConfigMap(&cm)

	vmReady, vmStatus, vmMissing := false, "", true
	if !r.SkipAppliance {
		vmReady, vmStatus, vmMissing, err = r.ensureRouterAppliance(ctx, &obj, ifaces, ext)
		if err != nil {
			// Control plane may still be useful; mark appliance error but keep requeue.
			_ = r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.Router) {
				o.Status.Phase = kmcv1alpha1.RouterPhasePending
				o.Status.PolicyConfigMap = cmName
				o.Status.PolicyGeneration = doc.Metadata.Generation
				o.Status.Interfaces = statusInterfaces(ifaces)
				o.Status.External = statusExternal(ext)
				o.Status.VMName = o.Name
				o.Status.VMStatus = vmStatus
				o.Status.VMReady = false
				o.Status.VMMissing = vmMissing
				o.Status.Agent = agentInfo
				o.Status.ObservedGeneration = o.Generation
				meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
					Type:               kmcv1alpha1.RouterConditionControlPlane,
					Status:             metav1.ConditionTrue,
					Reason:             "Ready",
					Message:            "policy ConfigMap and agent RBAC ensured",
					ObservedGeneration: o.Generation,
				})
				meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
					Type:               kmcv1alpha1.RouterConditionPolicy,
					Status:             metav1.ConditionTrue,
					Reason:             "Rendered",
					Message:            fmt.Sprintf("policy generation %d", doc.Metadata.Generation),
					ObservedGeneration: o.Generation,
				})
				meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
					Type:               kmcv1alpha1.RouterConditionAppliance,
					Status:             metav1.ConditionFalse,
					Reason:             "ApplianceError",
					Message:            err.Error(),
					ObservedGeneration: o.Generation,
				})
				meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
					Type:               kmcv1alpha1.RouterConditionReady,
					Status:             metav1.ConditionFalse,
					Reason:             "ApplianceError",
					Message:            err.Error(),
					ObservedGeneration: o.Generation,
				})
			})
			if r.Recorder != nil {
				r.Recorder.Event(&obj, corev1.EventTypeWarning, "ApplianceError", err.Error())
			}
			logger.Info("appliance ensure failed", "error", err)
			return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
		}
	} else {
		vmMissing = false
		vmReady = true
		vmStatus = "Skipped"
	}

	agentReady := agentInfo != nil && strings.EqualFold(agentInfo.Status, "Ready")
	phase := kmcv1alpha1.RouterPhasePending
	readyMsg := "waiting for appliance and agent"
	if vmReady && agentReady {
		phase = kmcv1alpha1.RouterPhaseReady
		readyMsg = fmt.Sprintf("router ready; VPCs [%s]", ifaceSummary(ifaces))
	} else if vmReady && !agentReady {
		readyMsg = "appliance ready; waiting for agent Ready"
	} else if !vmMissing {
		readyMsg = fmt.Sprintf("appliance status %s", vmStatus)
	}

	if err := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.Router) {
		o.Status.Phase = phase
		o.Status.PolicyConfigMap = cmName
		o.Status.PolicyGeneration = doc.Metadata.Generation
		o.Status.Interfaces = statusInterfaces(ifaces)
		o.Status.External = statusExternal(ext)
		o.Status.VMName = o.Name
		o.Status.VMStatus = vmStatus
		o.Status.VMReady = vmReady
		o.Status.VMMissing = vmMissing
		o.Status.Agent = agentInfo
		o.Status.ObservedGeneration = o.Generation
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.RouterConditionControlPlane,
			Status:             metav1.ConditionTrue,
			Reason:             "Ready",
			Message:            "policy ConfigMap and agent RBAC ensured",
			ObservedGeneration: o.Generation,
		})
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.RouterConditionPolicy,
			Status:             metav1.ConditionTrue,
			Reason:             "Rendered",
			Message:            fmt.Sprintf("policy generation %d; interfaces=%d", doc.Metadata.Generation, len(ifaces)),
			ObservedGeneration: o.Generation,
		})
		appStatus := metav1.ConditionFalse
		appReason := "Pending"
		if vmReady {
			appStatus = metav1.ConditionTrue
			appReason = "Ready"
		} else if vmMissing {
			appReason = "Missing"
		}
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.RouterConditionAppliance,
			Status:             appStatus,
			Reason:             appReason,
			Message:            vmStatus,
			ObservedGeneration: o.Generation,
		})
		agStatus := metav1.ConditionFalse
		agReason := "Pending"
		agMsg := "no agent heartbeat yet"
		if agentInfo != nil {
			agMsg = agentInfo.Status
			if agentInfo.LastError != "" {
				agMsg = agentInfo.LastError
			}
			if agentReady {
				agStatus = metav1.ConditionTrue
				agReason = "Ready"
			} else if strings.EqualFold(agentInfo.Status, "Error") {
				agReason = "Error"
			} else if strings.EqualFold(agentInfo.Status, "Stale") {
				agReason = "Stale"
			}
		}
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.RouterConditionAgent,
			Status:             agStatus,
			Reason:             agReason,
			Message:            agMsg,
			ObservedGeneration: o.Generation,
		})
		readyStatus := metav1.ConditionFalse
		readyReason := "Pending"
		if phase == kmcv1alpha1.RouterPhaseReady {
			readyStatus = metav1.ConditionTrue
			readyReason = "Ready"
		}
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.RouterConditionReady,
			Status:             readyStatus,
			Reason:             readyReason,
			Message:            readyMsg,
			ObservedGeneration: o.Generation,
		})
	}); err != nil {
		return ctrl.Result{}, err
	}

	// Requeue while waiting for agent / VM.
	if phase != kmcv1alpha1.RouterPhaseReady {
		return ctrl.Result{RequeueAfter: 20 * time.Second}, nil
	}
	return ctrl.Result{}, nil
}

func (r *RouterReconciler) reconcileDelete(ctx context.Context, obj *kmcv1alpha1.Router) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	if !controllerutil.ContainsFinalizer(obj, kmcv1alpha1.RouterFinalizer) {
		return ctrl.Result{}, nil
	}

	if err := r.clearAllVPCRouterAnnotations(ctx, obj); err != nil {
		return ctrl.Result{}, err
	}
	if !r.SkipAppliance {
		if err := r.deleteRouterAppliance(ctx, obj); err != nil {
			return ctrl.Result{}, err
		}
	}
	if err := r.deleteOwnedIPAddresses(ctx, obj); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.deleteRouterControlPlane(ctx, obj); err != nil {
		return ctrl.Result{}, err
	}

	controllerutil.RemoveFinalizer(obj, kmcv1alpha1.RouterFinalizer)
	if err := r.Update(ctx, obj); err != nil {
		return ctrl.Result{}, err
	}
	logger.Info("removed finalizer")
	return ctrl.Result{}, nil
}

func (r *RouterReconciler) fail(ctx context.Context, obj *kmcv1alpha1.Router, reason, msg string) (ctrl.Result, error) {
	_ = r.patchStatus(ctx, obj, func(o *kmcv1alpha1.Router) {
		o.Status.Phase = kmcv1alpha1.RouterPhaseError
		o.Status.ObservedGeneration = o.Generation
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.RouterConditionReady,
			Status:             metav1.ConditionFalse,
			Reason:             reason,
			Message:            msg,
			ObservedGeneration: o.Generation,
		})
	})
	if r.Recorder != nil {
		r.Recorder.Event(obj, corev1.EventTypeWarning, reason, msg)
	}
	return ctrl.Result{}, nil
}

func (r *RouterReconciler) patchStatus(ctx context.Context, obj *kmcv1alpha1.Router, mutate func(*kmcv1alpha1.Router)) error {
	latest := &kmcv1alpha1.Router{}
	if err := r.Get(ctx, client.ObjectKeyFromObject(obj), latest); err != nil {
		return err
	}
	before := latest.DeepCopy()
	mutate(latest)
	return r.Status().Patch(ctx, latest, client.MergeFrom(before))
}

// SetupWithManager registers the controller.
func (r *RouterReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&kmcv1alpha1.Router{}).
		Owns(&corev1.ConfigMap{}).
		Owns(&corev1.ServiceAccount{}).
		Owns(&corev1.Secret{}).
		Watches(&kmcv1alpha1.FloatingIP{}, handler.EnqueueRequestsFromMapFunc(r.mapFIPToRouter)).
		Watches(&kmcv1alpha1.PortForward{}, handler.EnqueueRequestsFromMapFunc(r.mapPFToRouter)).
		Watches(&kmcv1alpha1.IPAddress{}, handler.EnqueueRequestsFromMapFunc(r.mapIPAddressToRouter),
			builder.WithPredicates()).
		Complete(r)
}

func (r *RouterReconciler) mapFIPToRouter(ctx context.Context, obj client.Object) []reconcile.Request {
	fip, ok := obj.(*kmcv1alpha1.FloatingIP)
	if !ok {
		return nil
	}
	if fip.Spec.RouterRef != nil && fip.Spec.RouterRef.Name != "" {
		return []reconcile.Request{{
			NamespacedName: types.NamespacedName{Namespace: fip.Namespace, Name: fip.Spec.RouterRef.Name},
		}}
	}
	return r.routersForVPC(ctx, fip.Namespace, fip.Spec.VPCRef.Name)
}

func (r *RouterReconciler) mapPFToRouter(ctx context.Context, obj client.Object) []reconcile.Request {
	pf, ok := obj.(*kmcv1alpha1.PortForward)
	if !ok {
		return nil
	}
	if pf.Spec.RouterRef != nil && pf.Spec.RouterRef.Name != "" {
		return []reconcile.Request{{
			NamespacedName: types.NamespacedName{Namespace: pf.Namespace, Name: pf.Spec.RouterRef.Name},
		}}
	}
	return r.routersForVPC(ctx, pf.Namespace, pf.Spec.VPCRef.Name)
}

func (r *RouterReconciler) mapIPAddressToRouter(ctx context.Context, obj client.Object) []reconcile.Request {
	ip, ok := obj.(*kmcv1alpha1.IPAddress)
	if !ok {
		return nil
	}
	if ip.Spec.ClaimRef != nil && ip.Spec.ClaimRef.Kind == "Router" && ip.Spec.ClaimRef.Name != "" {
		return []reconcile.Request{{
			NamespacedName: types.NamespacedName{Namespace: ip.Namespace, Name: ip.Spec.ClaimRef.Name},
		}}
	}
	if ip.Spec.PoolRef.Kind == "VPC" && ip.Spec.Interface != nil {
		return r.routersForVPC(ctx, ip.Namespace, ip.Spec.PoolRef.Name)
	}
	return nil
}

func (r *RouterReconciler) routersForVPC(ctx context.Context, namespace, vpcName string) []reconcile.Request {
	vpcName = strings.TrimSpace(vpcName)
	if vpcName == "" {
		return nil
	}
	var list kmcv1alpha1.RouterList
	if err := r.List(ctx, &list, client.InNamespace(namespace)); err != nil {
		return nil
	}
	var reqs []reconcile.Request
	for i := range list.Items {
		rtObj := &list.Items[i]
		for _, att := range rtObj.Spec.VPCs {
			if strings.TrimSpace(att.Name) == vpcName {
				reqs = append(reqs, reconcile.Request{
					NamespacedName: types.NamespacedName{Namespace: namespace, Name: rtObj.Name},
				})
				break
			}
		}
	}
	return reqs
}
