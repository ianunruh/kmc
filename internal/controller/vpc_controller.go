package controller

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	"github.com/ianunruh/kmc/internal/ipam"
)

// VPCReconciler reconciles VPC objects and owns Multus NADs.
type VPCReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=vpcs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=vpcs/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=vpcs/finalizers,verbs=update
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=vlanpools,verbs=get;list;watch
// +kubebuilder:rbac:groups=k8s.cni.cncf.io,resources=network-attachment-definitions,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch

func (r *VPCReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var obj kmcv1alpha1.VPC
	if err := r.Get(ctx, req.NamespacedName, &obj); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	if !obj.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, &obj)
	}

	if !controllerutil.ContainsFinalizer(&obj, kmcv1alpha1.VPCFinalizer) {
		controllerutil.AddFinalizer(&obj, kmcv1alpha1.VPCFinalizer)
		if err := r.Update(ctx, &obj); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if err := validateVPCSpec(&obj); err != nil {
		_ = r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.VPC) {
			o.Status.Phase = kmcv1alpha1.VPCPhaseError
			o.Status.NetworkAttachmentReady = false
			o.Status.ObservedGeneration = o.Generation
			meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
				Type:               kmcv1alpha1.VPCConditionReady,
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

	poolName := strings.TrimSpace(obj.Spec.VLANPoolRef.Name)
	if poolName == "" {
		return r.fail(ctx, &obj, "InvalidSpec", "vlanPoolRef.name is required")
	}

	var pool kmcv1alpha1.VLANPool
	if err := r.Get(ctx, client.ObjectKey{Name: poolName}, &pool); err != nil {
		if apierrors.IsNotFound(err) {
			return r.pending(ctx, &obj, "VLANPoolNotFound", fmt.Sprintf("VLANPool %q not found", poolName))
		}
		return ctrl.Result{}, err
	}

	if obj.Status.VLAN == 0 {
		vlan, bridge, err := r.allocateVLAN(ctx, &obj, &pool)
		if err != nil {
			return r.fail(ctx, &obj, "VLANAllocateFailed", err.Error())
		}
		if err := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.VPC) {
			o.Status.VLAN = vlan
			o.Status.Bridge = bridge
			o.Status.Phase = kmcv1alpha1.VPCPhasePending
			o.Status.ObservedGeneration = o.Generation
			meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
				Type:               kmcv1alpha1.VPCConditionReady,
				Status:             metav1.ConditionFalse,
				Reason:             "VLANAllocated",
				Message:            fmt.Sprintf("assigned VLAN %d from pool %s", vlan, pool.Name),
				ObservedGeneration: o.Generation,
			})
		}); err != nil {
			return ctrl.Result{}, err
		}
		// Re-fetch after status patch.
		if err := r.Get(ctx, req.NamespacedName, &obj); err != nil {
			return ctrl.Result{}, err
		}
		logger.Info("allocated VLAN", "vlan", obj.Status.VLAN, "pool", pool.Name)
	}

	// Ensure Multus NAD
	if err := r.ensureNAD(ctx, &obj, &pool); err != nil {
		return r.fail(ctx, &obj, "NADError", err.Error())
	}

	// Sync routerRef from NAD annotation if present (set by future Router controller / console).
	routerName := ""
	nad := newNADUnstructured(obj.Namespace, obj.Name)
	if err := r.Get(ctx, client.ObjectKey{Namespace: obj.Namespace, Name: obj.Name}, nad); err == nil {
		routerName = strings.TrimSpace(nad.GetAnnotations()[kmcv1alpha1.AnnotationRouter])
	}

	if err := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.VPC) {
		o.Status.Phase = kmcv1alpha1.VPCPhaseReady
		o.Status.NetworkAttachmentReady = true
		o.Status.Bridge = pool.Spec.Bridge
		if o.Status.Bridge == "" {
			o.Status.Bridge = obj.Status.Bridge
		}
		o.Status.ObservedGeneration = o.Generation
		if routerName != "" {
			o.Status.RouterRef = &corev1.LocalObjectReference{Name: routerName}
		}
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.VPCConditionReady,
			Status:             metav1.ConditionTrue,
			Reason:             "Ready",
			Message:            fmt.Sprintf("VLAN %d on bridge %s", o.Status.VLAN, o.Status.Bridge),
			ObservedGeneration: o.Generation,
		})
	}); err != nil {
		return ctrl.Result{}, err
	}

	return ctrl.Result{}, nil
}

func (r *VPCReconciler) reconcileDelete(ctx context.Context, obj *kmcv1alpha1.VPC) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	if !controllerutil.ContainsFinalizer(obj, kmcv1alpha1.VPCFinalizer) {
		return ctrl.Result{}, nil
	}

	nad := newNADUnstructured(obj.Namespace, obj.Name)
	err := r.Get(ctx, client.ObjectKey{Namespace: obj.Namespace, Name: obj.Name}, nad)
	if err == nil {
		if err := r.Delete(ctx, nad); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		logger.Info("deleted Multus NAD")
	} else if !apierrors.IsNotFound(err) {
		return ctrl.Result{}, err
	}

	controllerutil.RemoveFinalizer(obj, kmcv1alpha1.VPCFinalizer)
	if err := r.Update(ctx, obj); err != nil {
		return ctrl.Result{}, err
	}
	logger.Info("removed finalizer")
	return ctrl.Result{}, nil
}

func (r *VPCReconciler) allocateVLAN(ctx context.Context, obj *kmcv1alpha1.VPC, pool *kmcv1alpha1.VLANPool) (vlan int32, bridge string, err error) {
	used := make(map[int32]struct{})
	for _, ex := range pool.Spec.Exclude {
		used[ex] = struct{}{}
	}
	var vpcs kmcv1alpha1.VPCList
	if err := r.List(ctx, &vpcs); err != nil {
		return 0, "", err
	}
	for i := range vpcs.Items {
		v := &vpcs.Items[i]
		if v.Name == obj.Name && v.Namespace == obj.Namespace {
			continue
		}
		if v.Spec.VLANPoolRef.Name != pool.Name {
			continue
		}
		if v.Status.VLAN != 0 {
			used[v.Status.VLAN] = struct{}{}
		}
	}
	free, ok := ipam.FirstFreeVLAN(pool.Spec.Start, pool.Spec.End, used)
	if !ok {
		return 0, "", fmt.Errorf("VLAN pool %q exhausted (%d–%d)", pool.Name, pool.Spec.Start, pool.Spec.End)
	}
	return free, pool.Spec.Bridge, nil
}

func (r *VPCReconciler) ensureNAD(ctx context.Context, obj *kmcv1alpha1.VPC, pool *kmcv1alpha1.VLANPool) error {
	bridge := obj.Status.Bridge
	if bridge == "" {
		bridge = pool.Spec.Bridge
	}
	config, err := bridgeCNIConfig(obj.Name, bridge, obj.Status.VLAN)
	if err != nil {
		return err
	}

	labels := map[string]string{
		kmcv1alpha1.LabelManagedBy: kmcv1alpha1.ManagedByKMC,
		kmcv1alpha1.LabelResource:  kmcv1alpha1.ResourceVPC,
		kmcv1alpha1.LabelVLAN:      strconv.Itoa(int(obj.Status.VLAN)),
		kmcv1alpha1.LabelVLANPool:  pool.Name,
	}
	annotations := map[string]string{}
	if d := strings.TrimSpace(obj.Spec.Description); d != "" {
		annotations[kmcv1alpha1.AnnotationDescription] = d
	}
	if c := strings.TrimSpace(obj.Spec.CIDR); c != "" {
		annotations[kmcv1alpha1.AnnotationCIDR] = c
		if gw := strings.TrimSpace(obj.Spec.Gateway); gw != "" {
			annotations[kmcv1alpha1.AnnotationGateway] = gw
		}
		dns := make([]string, 0, len(obj.Spec.DNS))
		for _, d := range obj.Spec.DNS {
			if t := strings.TrimSpace(d); t != "" {
				dns = append(dns, t)
			}
		}
		if len(dns) == 0 {
			for _, d := range pool.Spec.DNS {
				if t := strings.TrimSpace(d); t != "" {
					dns = append(dns, t)
				}
			}
		}
		if len(dns) > 0 {
			annotations[kmcv1alpha1.AnnotationDNS] = strings.Join(dns, ",")
		}
	}

	existing := newNADUnstructured(obj.Namespace, obj.Name)
	err = r.Get(ctx, client.ObjectKey{Namespace: obj.Namespace, Name: obj.Name}, existing)
	if apierrors.IsNotFound(err) {
		nad := newNADUnstructured(obj.Namespace, obj.Name)
		nad.SetLabels(labels)
		nad.SetAnnotations(annotations)
		if err := unstructured.SetNestedField(nad.Object, config, "spec", "config"); err != nil {
			return err
		}
		if err := controllerutil.SetControllerReference(obj, nad, r.Scheme); err != nil {
			return err
		}
		return r.Create(ctx, nad)
	}
	if err != nil {
		return err
	}

	// Preserve router annotation written by router/console.
	if rtr := existing.GetAnnotations()[kmcv1alpha1.AnnotationRouter]; rtr != "" {
		annotations[kmcv1alpha1.AnnotationRouter] = rtr
	}
	before := existing.DeepCopy()
	existing.SetLabels(labels)
	existing.SetAnnotations(annotations)
	if err := unstructured.SetNestedField(existing.Object, config, "spec", "config"); err != nil {
		return err
	}
	if err := controllerutil.SetControllerReference(obj, existing, r.Scheme); err != nil {
		return err
	}
	return r.Patch(ctx, existing, client.MergeFrom(before))
}

func validateVPCSpec(obj *kmcv1alpha1.VPC) error {
	if strings.TrimSpace(obj.Spec.VLANPoolRef.Name) == "" {
		return fmt.Errorf("vlanPoolRef.name is required")
	}
	cidr := strings.TrimSpace(obj.Spec.CIDR)
	if cidr == "" {
		if strings.TrimSpace(obj.Spec.Gateway) != "" {
			return fmt.Errorf("gateway requires cidr")
		}
		return nil
	}
	network, err := ipam.ParseIPv4CIDR(cidr)
	if err != nil {
		return err
	}
	if gw := strings.TrimSpace(obj.Spec.Gateway); gw != "" {
		if err := ipam.ValidateIPv4Address(gw); err != nil {
			return fmt.Errorf("gateway: %w", err)
		}
		if !ipam.ContainsIPv4(network, gw) {
			return fmt.Errorf("gateway %s is outside cidr %s", gw, cidr)
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
	return nil
}

func (r *VPCReconciler) pending(ctx context.Context, obj *kmcv1alpha1.VPC, reason, msg string) (ctrl.Result, error) {
	if err := r.patchStatus(ctx, obj, func(o *kmcv1alpha1.VPC) {
		o.Status.Phase = kmcv1alpha1.VPCPhasePending
		o.Status.NetworkAttachmentReady = false
		o.Status.ObservedGeneration = o.Generation
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.VPCConditionReady,
			Status:             metav1.ConditionFalse,
			Reason:             reason,
			Message:            msg,
			ObservedGeneration: o.Generation,
		})
	}); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

func (r *VPCReconciler) fail(ctx context.Context, obj *kmcv1alpha1.VPC, reason, msg string) (ctrl.Result, error) {
	if r.Recorder != nil {
		r.Recorder.Event(obj, corev1.EventTypeWarning, reason, msg)
	}
	if err := r.patchStatus(ctx, obj, func(o *kmcv1alpha1.VPC) {
		o.Status.Phase = kmcv1alpha1.VPCPhaseError
		o.Status.NetworkAttachmentReady = false
		o.Status.ObservedGeneration = o.Generation
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.VPCConditionReady,
			Status:             metav1.ConditionFalse,
			Reason:             reason,
			Message:            msg,
			ObservedGeneration: o.Generation,
		})
	}); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

func (r *VPCReconciler) patchStatus(ctx context.Context, obj *kmcv1alpha1.VPC, mutate func(*kmcv1alpha1.VPC)) error {
	latest := &kmcv1alpha1.VPC{}
	if err := r.Get(ctx, client.ObjectKeyFromObject(obj), latest); err != nil {
		return err
	}
	before := latest.DeepCopy()
	mutate(latest)
	return r.Status().Patch(ctx, latest, client.MergeFrom(before))
}

// SetupWithManager registers the controller with the Manager.
func (r *VPCReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&kmcv1alpha1.VPC{}).
		Named("vpc").
		Complete(r)
}
