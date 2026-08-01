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

// FloatingIPReconciler reconciles FloatingIP objects.
// Claims a companion IPAddress for the public address. Programming onto a
// router appliance is projected by the Router controller.
type FloatingIPReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=floatingips,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=floatingips/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=floatingips/finalizers,verbs=update
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=ipaddresses,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=ippools,verbs=get;list;watch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=vpcs,verbs=get;list;watch
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
		return r.reconcileDelete(ctx, &obj)
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

	addr, prefix, err := r.ensureIPAddressClaim(ctx, &obj)
	if err != nil {
		if statusErr := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.FloatingIP) {
			o.Status.Phase = kmcv1alpha1.FloatingIPPhaseError
			o.Status.Programmed = false
			o.Status.ObservedGeneration = o.Generation
			meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
				Type:               kmcv1alpha1.FloatingIPConditionReady,
				Status:             metav1.ConditionFalse,
				Reason:             "AllocateFailed",
				Message:            err.Error(),
				ObservedGeneration: o.Generation,
			})
		}); statusErr != nil {
			return ctrl.Result{}, statusErr
		}
		if r.Recorder != nil {
			r.Recorder.Event(&obj, corev1.EventTypeWarning, "AllocateFailed", err.Error())
		}
		logger.Info("allocate failed", "error", err)
		return ctrl.Result{}, nil
	}

	phase := kmcv1alpha1.FloatingIPPhaseHeld
	if strings.TrimSpace(obj.Spec.PrivateAddress) != "" {
		phase = kmcv1alpha1.FloatingIPPhaseAssociated
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
	reason := "WaitingForRouter"
	msg := "public address claimed; waiting for a Router attached to this VPC to program SNAT/DNAT"
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
			reason = "Ready"
			msg = "router agent has programmed SNAT/DNAT"
		}
	}

	if err := r.patchStatus(ctx, &obj, func(o *kmcv1alpha1.FloatingIP) {
		o.Status.Phase = phase
		o.Status.Address = addr
		o.Status.PrefixLength = prefix
		o.Status.Programmed = programmed
		o.Status.ObservedGeneration = o.Generation
		status := metav1.ConditionFalse
		if ready {
			status = metav1.ConditionTrue
		}
		meta.SetStatusCondition(&o.Status.Conditions, metav1.Condition{
			Type:               kmcv1alpha1.FloatingIPConditionReady,
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

func (r *FloatingIPReconciler) reconcileDelete(ctx context.Context, obj *kmcv1alpha1.FloatingIP) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	if !controllerutil.ContainsFinalizer(obj, kmcv1alpha1.FloatingIPFinalizer) {
		return ctrl.Result{}, nil
	}

	if err := r.deleteOwnedIPAddress(ctx, obj); err != nil {
		return ctrl.Result{}, err
	}

	controllerutil.RemoveFinalizer(obj, kmcv1alpha1.FloatingIPFinalizer)
	if err := r.Update(ctx, obj); err != nil {
		return ctrl.Result{}, err
	}
	logger.Info("removed finalizer")
	return ctrl.Result{}, nil
}

func (r *FloatingIPReconciler) deleteOwnedIPAddress(ctx context.Context, obj *kmcv1alpha1.FloatingIP) error {
	addr := strings.TrimSpace(obj.Status.Address)
	if addr == "" {
		addr = strings.TrimSpace(obj.Spec.Address)
	}
	if addr == "" {
		// Fall back: list IPAddresses claimed by this FIP
		var list kmcv1alpha1.IPAddressList
		if err := r.List(ctx, &list, client.InNamespace(obj.Namespace)); err != nil {
			return err
		}
		for i := range list.Items {
			ip := &list.Items[i]
			if isClaimedByFloatingIP(ip, obj) {
				if err := r.Delete(ctx, ip); err != nil && !apierrors.IsNotFound(err) {
					return err
				}
			}
		}
		return nil
	}
	name := ipam.AddressObjectName(addr)
	var ip kmcv1alpha1.IPAddress
	if err := r.Get(ctx, client.ObjectKey{Namespace: obj.Namespace, Name: name}, &ip); err != nil {
		if apierrors.IsNotFound(err) {
			return nil
		}
		return err
	}
	if !isClaimedByFloatingIP(&ip, obj) && !isOwnedBy(obj, &ip) {
		return nil
	}
	if err := r.Delete(ctx, &ip); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}

func isOwnedBy(owner client.Object, obj metav1.Object) bool {
	for _, ref := range obj.GetOwnerReferences() {
		if ref.UID == owner.GetUID() {
			return true
		}
	}
	return false
}

func isClaimedByFloatingIP(ip *kmcv1alpha1.IPAddress, fip *kmcv1alpha1.FloatingIP) bool {
	if isOwnedBy(fip, ip) {
		return true
	}
	ref := ip.Spec.ClaimRef
	if ref == nil {
		return false
	}
	return ref.Kind == "FloatingIP" && ref.Name == fip.Name &&
		(ref.Namespace == "" || ref.Namespace == fip.Namespace)
}

// ensureIPAddressClaim allocates (if needed) and creates an IPAddress for the public address.
// Returns the claimed address and prefix length.
func (r *FloatingIPReconciler) ensureIPAddressClaim(ctx context.Context, obj *kmcv1alpha1.FloatingIP) (string, int32, error) {
	// Already have status address and claim exists?
	if statusAddr := strings.TrimSpace(obj.Status.Address); statusAddr != "" {
		name := ipam.AddressObjectName(statusAddr)
		var existing kmcv1alpha1.IPAddress
		if err := r.Get(ctx, client.ObjectKey{Namespace: obj.Namespace, Name: name}, &existing); err == nil {
			prefix := existing.Spec.PrefixLength
			if obj.Status.PrefixLength != 0 {
				prefix = obj.Status.PrefixLength
			}
			return statusAddr, prefix, nil
		}
	}

	poolKind := strings.TrimSpace(obj.Spec.PoolRef.Kind)
	poolName := strings.TrimSpace(obj.Spec.PoolRef.Name)
	if poolKind != "IPPool" {
		// Prefer IPPool for public floats; allow pre-set address without pool lookup.
		preferred := strings.TrimSpace(obj.Spec.Address)
		if preferred == "" {
			return "", 0, fmt.Errorf("poolRef.kind must be IPPool to allocate (got %q)", poolKind)
		}
		// Create claim with prefix from status or 32 default — require IPPool for full path
		return "", 0, fmt.Errorf("poolRef.kind must be IPPool (got %q)", poolKind)
	}

	var pool kmcv1alpha1.IPPool
	if err := r.Get(ctx, client.ObjectKey{Name: poolName}, &pool); err != nil {
		if apierrors.IsNotFound(err) {
			return "", 0, fmt.Errorf("IPPool %q not found", poolName)
		}
		return "", 0, err
	}

	window, err := ipam.ParsePoolWindow(pool.Spec.CIDR, pool.Spec.Gateway, pool.Spec.Start, pool.Spec.End, pool.Spec.Exclude)
	if err != nil {
		return "", 0, fmt.Errorf("IPPool %q: %w", poolName, err)
	}
	prefix := window.PrefixLength()

	used, err := r.listUsedAddresses(ctx, obj.Namespace, poolKind, poolName)
	if err != nil {
		return "", 0, err
	}

	preferred := strings.TrimSpace(obj.Spec.Address)
	var address string
	if preferred != "" {
		if err := ipam.ValidateIPv4Address(preferred); err != nil {
			return "", 0, err
		}
		if !window.Contains(preferred) {
			return "", 0, fmt.Errorf("address %s is outside pool %s", preferred, pool.Spec.CIDR)
		}
		if _, taken := used[preferred]; taken {
			// Allow if the claim is already ours
			name := ipam.AddressObjectName(preferred)
			var existing kmcv1alpha1.IPAddress
			if err := r.Get(ctx, client.ObjectKey{Namespace: obj.Namespace, Name: name}, &existing); err == nil &&
				isClaimedByFloatingIP(&existing, obj) {
				return preferred, existing.Spec.PrefixLength, nil
			}
			return "", 0, fmt.Errorf("address %s is already claimed", preferred)
		}
		address = preferred
	} else {
		// Prefer reusing status if set
		if statusAddr := strings.TrimSpace(obj.Status.Address); statusAddr != "" {
			name := ipam.AddressObjectName(statusAddr)
			var existing kmcv1alpha1.IPAddress
			if err := r.Get(ctx, client.ObjectKey{Namespace: obj.Namespace, Name: name}, &existing); err == nil &&
				isClaimedByFloatingIP(&existing, obj) {
				return statusAddr, existing.Spec.PrefixLength, nil
			}
		}
		// Try allocate with 409 retry
		for i := 0; i < 64; i++ {
			free, ok := window.FirstFree(used)
			if !ok {
				return "", 0, fmt.Errorf("IPPool %q exhausted", poolName)
			}
			if err := r.createIPAddressClaim(ctx, obj, free, prefix, poolKind, poolName); err != nil {
				if apierrors.IsAlreadyExists(err) {
					used[free] = struct{}{}
					continue
				}
				return "", 0, err
			}
			return free, prefix, nil
		}
		return "", 0, fmt.Errorf("IPPool %q: could not allocate after conflicts", poolName)
	}

	if err := r.createIPAddressClaim(ctx, obj, address, prefix, poolKind, poolName); err != nil {
		if apierrors.IsAlreadyExists(err) {
			name := ipam.AddressObjectName(address)
			var existing kmcv1alpha1.IPAddress
			if getErr := r.Get(ctx, client.ObjectKey{Namespace: obj.Namespace, Name: name}, &existing); getErr == nil &&
				isClaimedByFloatingIP(&existing, obj) {
				return address, existing.Spec.PrefixLength, nil
			}
			return "", 0, fmt.Errorf("address %s is already claimed", address)
		}
		return "", 0, err
	}
	return address, prefix, nil
}

func (r *FloatingIPReconciler) listUsedAddresses(ctx context.Context, namespace, poolKind, poolName string) (map[string]struct{}, error) {
	used := make(map[string]struct{})
	// Namespace-local claims (FIP lives in tenant ns)
	var list kmcv1alpha1.IPAddressList
	if err := r.List(ctx, &list, client.InNamespace(namespace)); err != nil {
		return nil, err
	}
	for i := range list.Items {
		ip := &list.Items[i]
		if ip.Spec.PoolRef.Kind != poolKind || ip.Spec.PoolRef.Name != poolName {
			continue
		}
		addr := strings.TrimSpace(ip.Spec.Address)
		if addr != "" {
			used[addr] = struct{}{}
		}
	}
	// Also cluster-wide for same IPPool (other namespaces may hold public floats)
	var all kmcv1alpha1.IPAddressList
	if err := r.List(ctx, &all); err != nil {
		// Fall back to namespace-only if cluster list fails
		return used, nil
	}
	for i := range all.Items {
		ip := &all.Items[i]
		if ip.Spec.PoolRef.Kind != poolKind || ip.Spec.PoolRef.Name != poolName {
			continue
		}
		addr := strings.TrimSpace(ip.Spec.Address)
		if addr != "" {
			used[addr] = struct{}{}
		}
	}
	return used, nil
}

func (r *FloatingIPReconciler) createIPAddressClaim(
	ctx context.Context,
	fip *kmcv1alpha1.FloatingIP,
	address string,
	prefix int32,
	poolKind, poolName string,
) error {
	name := ipam.AddressObjectName(address)
	ip := &kmcv1alpha1.IPAddress{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: fip.Namespace,
			Labels: map[string]string{
				kmcv1alpha1.LabelManagedBy: kmcv1alpha1.ManagedByKMC,
				kmcv1alpha1.LabelAddress:   address,
				kmcv1alpha1.LabelPool:      poolName,
			},
		},
		Spec: kmcv1alpha1.IPAddressSpec{
			Address:      address,
			PrefixLength: prefix,
			PoolRef: kmcv1alpha1.PoolReference{
				Kind: poolKind,
				Name: poolName,
			},
			ClaimRef: &corev1.ObjectReference{
				APIVersion: kmcv1alpha1.GroupVersion.String(),
				Kind:       "FloatingIP",
				Namespace:  fip.Namespace,
				Name:       fip.Name,
				UID:        fip.UID,
			},
		},
	}
	if err := controllerutil.SetControllerReference(fip, ip, r.Scheme); err != nil {
		return err
	}
	return r.Create(ctx, ip)
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
		Owns(&kmcv1alpha1.IPAddress{}).
		Watches(&kmcv1alpha1.Router{}, handler.EnqueueRequestsFromMapFunc(r.mapRouterToFloatingIPs)).
		Named("floatingip").
		Complete(r)
}

func (r *FloatingIPReconciler) mapRouterToFloatingIPs(ctx context.Context, obj client.Object) []reconcile.Request {
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
	var list kmcv1alpha1.FloatingIPList
	if err := r.List(ctx, &list, client.InNamespace(rt.Namespace)); err != nil {
		return nil
	}
	var reqs []reconcile.Request
	for i := range list.Items {
		fip := &list.Items[i]
		if fip.Spec.RouterRef != nil && strings.TrimSpace(fip.Spec.RouterRef.Name) == rt.Name {
			reqs = append(reqs, reconcile.Request{
				NamespacedName: types.NamespacedName{Namespace: fip.Namespace, Name: fip.Name},
			})
			continue
		}
		if _, ok := vpcs[strings.TrimSpace(fip.Spec.VPCRef.Name)]; ok {
			reqs = append(reqs, reconcile.Request{
				NamespacedName: types.NamespacedName{Namespace: fip.Namespace, Name: fip.Name},
			})
		}
	}
	return reqs
}
