package controller

import (
	"context"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
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

// Guest VM IPAM annotations (console + controller parity).
const (
	annotationGuestIPv4    = "kmc.ianunruh.com/ipv4"
	annotationGuestIPAMPool = "kmc.ianunruh.com/ipam-pool"
)

// VirtualMachineIPAMReconciler ensures Multus guest IPAddress claims for workload VMs:
// adopt existing claimRef leases (set ownerRef for GC), backfill missing claims,
// and stamp ipv4 annotations when empty.
//
// Router appliances (role=router) are skipped — gateway/public claims are owned
// by the Router controller. Console still pre-claims on create for static
// netplan; this reconciler is the cluster-side source of truth for adopt/GC.
type VirtualMachineIPAMReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// +kubebuilder:rbac:groups=kubevirt.io,resources=virtualmachines,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=ipaddresses,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=ippools,verbs=get;list;watch
// +kubebuilder:rbac:groups=kmc.ianunruh.com,resources=vpcs,verbs=get;list;watch
// +kubebuilder:rbac:groups=k8s.cni.cncf.io,resources=network-attachment-definitions,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch

func (r *VirtualMachineIPAMReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	vm := newVMUnstructured(req.Namespace, req.Name)
	if err := r.Get(ctx, req.NamespacedName, vm); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Skip router appliances — their Multus IPs are Router-owned gateway/public claims.
	if labels := vm.GetLabels(); labels != nil && labels[kmcv1alpha1.LabelRole] == kmcv1alpha1.RoleRouter {
		return ctrl.Result{}, nil
	}

	attachments, err := multusAttachmentsFromVM(vm)
	if err != nil {
		logger.Info("skip VM IPAM: parse networks", "error", err)
		return ctrl.Result{}, nil
	}
	if len(attachments) == 0 {
		return ctrl.Result{}, nil
	}

	// Existing claims for this VM (by claimRef).
	claims, err := r.listVMClaims(ctx, vm)
	if err != nil {
		return ctrl.Result{}, err
	}

	// Index by pool key "kind/name"
	byPool := make(map[string]*kmcv1alpha1.IPAddress)
	for i := range claims {
		ip := &claims[i]
		key := poolKey(ip.Spec.PoolRef.Kind, ip.Spec.PoolRef.Name)
		// Prefer first; multiple claims on same pool are unusual for guests
		if _, ok := byPool[key]; !ok {
			byPool[key] = ip
		}
	}

	var ensuredAddrs []string
	var ensuredPools []string
	changed := false

	for _, att := range attachments {
		poolKind, poolName, window, poolObj, resolveErr := r.resolvePoolForMultus(ctx, vm.GetNamespace(), att.NetworkName)
		if resolveErr != nil {
			logger.Info("resolve pool", "network", att.NetworkName, "error", resolveErr)
			continue
		}
		if poolKind == "" {
			// No IPAM for this Multus network
			continue
		}

		// Ensure static NAD when IPPool ships a CNI template
		if poolKind == "IPPool" && poolObj != nil {
			if err := ensureStaticNADForPool(ctx, r.Client, r.Scheme, vm.GetNamespace(), poolObj); err != nil {
				logger.Info("ensure static NAD", "pool", poolName, "error", err)
			}
		}

		key := poolKey(poolKind, poolName)
		if existing := byPool[key]; existing != nil {
			if adoptErr := r.adoptClaim(ctx, vm, existing); adoptErr != nil {
				return ctrl.Result{}, adoptErr
			}
			// Patch MAC/hostname if missing and we have them
			if patchErr := r.enrichClaimInterface(ctx, existing, att, vm.GetName()); patchErr != nil {
				return ctrl.Result{}, patchErr
			}
			ensuredAddrs = append(ensuredAddrs, existing.Spec.Address)
			ensuredPools = append(ensuredPools, poolName)
			continue
		}

		// Allocate new claim
		used, listErr := listUsedAddressesByPool(ctx, r.Client, poolKind, poolName)
		if listErr != nil {
			return ctrl.Result{}, listErr
		}
		mac := strings.ToLower(strings.TrimSpace(att.MAC))
		hostname := vm.GetName()

		addr, _, allocErr := allocateIPAddressFromWindow(
			ctx,
			r.Client,
			vm.GetNamespace(),
			window,
			poolKind,
			poolName,
			"",
			used,
			func(ip *kmcv1alpha1.IPAddress) bool { return isClaimedByVM(ip, vm) },
			func(ctx context.Context, address string, prefix int32) error {
				return r.createGuestIPAddressClaim(ctx, vm, address, prefix, poolKind, poolName, mac, hostname)
			},
		)
		if allocErr != nil {
			if r.Recorder != nil {
				r.Recorder.Eventf(vm, corev1.EventTypeWarning, "IPAMAllocateFailed",
					"Multus %s pool %s/%s: %v", att.NetworkName, poolKind, poolName, allocErr)
			}
			return ctrl.Result{}, allocErr
		}
		ensuredAddrs = append(ensuredAddrs, addr)
		ensuredPools = append(ensuredPools, poolName)
		changed = true
		logger.Info("allocated guest IPAddress", "address", addr, "pool", poolName, "network", att.NetworkName)
	}

	if annErr := r.stampIPv4Annotations(ctx, vm, ensuredAddrs, ensuredPools); annErr != nil {
		return ctrl.Result{}, annErr
	}
	if changed && r.Recorder != nil {
		r.Recorder.Eventf(vm, corev1.EventTypeNormal, "IPAMBound",
			"ensured %d Multus IPAddress claim(s)", len(ensuredAddrs))
	}
	return ctrl.Result{}, nil
}

type multusAttachment struct {
	// Multus network name as on the VM (may be bare or ns/name)
	NetworkName string
	// Guest NIC MAC when stamped on the interface
	MAC string
}

func multusAttachmentsFromVM(vm *unstructured.Unstructured) ([]multusAttachment, error) {
	networks, _, err := unstructured.NestedSlice(vm.Object, "spec", "template", "spec", "networks")
	if err != nil {
		return nil, err
	}
	interfaces, _, _ := unstructured.NestedSlice(vm.Object, "spec", "template", "spec", "domain", "devices", "interfaces")

	macByNet := map[string]string{}
	for _, raw := range interfaces {
		m, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		mac, _ := m["macAddress"].(string)
		if name != "" && mac != "" {
			macByNet[name] = strings.ToLower(strings.TrimSpace(mac))
		}
	}

	var out []multusAttachment
	for _, raw := range networks {
		m, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		netName, _ := m["name"].(string)
		multus, ok := m["multus"].(map[string]interface{})
		if !ok {
			continue
		}
		networkName, _ := multus["networkName"].(string)
		networkName = strings.TrimSpace(networkName)
		if networkName == "" {
			continue
		}
		out = append(out, multusAttachment{
			NetworkName: networkName,
			MAC:         macByNet[netName],
		})
	}
	return out, nil
}

func poolKey(kind, name string) string {
	return strings.TrimSpace(kind) + "/" + strings.TrimSpace(name)
}

func (r *VirtualMachineIPAMReconciler) listVMClaims(ctx context.Context, vm *unstructured.Unstructured) ([]kmcv1alpha1.IPAddress, error) {
	var list kmcv1alpha1.IPAddressList
	if err := r.List(ctx, &list, client.InNamespace(vm.GetNamespace())); err != nil {
		return nil, err
	}
	var out []kmcv1alpha1.IPAddress
	for i := range list.Items {
		if isClaimedByVM(&list.Items[i], vm) {
			out = append(out, list.Items[i])
		}
	}
	return out, nil
}

func isClaimedByVM(ip *kmcv1alpha1.IPAddress, vm *unstructured.Unstructured) bool {
	for _, ref := range ip.GetOwnerReferences() {
		if ref.UID == vm.GetUID() && ref.Kind == "VirtualMachine" {
			return true
		}
	}
	ref := ip.Spec.ClaimRef
	if ref == nil {
		return false
	}
	if !strings.EqualFold(ref.Kind, "VirtualMachine") {
		return false
	}
	if ref.Name != vm.GetName() {
		return false
	}
	if ref.Namespace != "" && ref.Namespace != vm.GetNamespace() {
		return false
	}
	return true
}

func (r *VirtualMachineIPAMReconciler) adoptClaim(ctx context.Context, vm *unstructured.Unstructured, ip *kmcv1alpha1.IPAddress) error {
	// Already controlled by this VM?
	for _, ref := range ip.GetOwnerReferences() {
		if ref.UID == vm.GetUID() && ref.Controller != nil && *ref.Controller {
			return nil
		}
	}
	before := ip.DeepCopy()
	if err := controllerutil.SetControllerReference(vm, ip, r.Scheme); err != nil {
		// Unstructured VM may not be in scheme — set owner ref manually.
		if setErr := setUnstructuredControllerReference(vm, ip); setErr != nil {
			return fmt.Errorf("adopt IPAddress %s: %w", ip.Name, setErr)
		}
	}
	return r.Patch(ctx, ip, client.MergeFrom(before))
}

func setUnstructuredControllerReference(owner *unstructured.Unstructured, controlled metav1.Object) error {
	if owner.GetUID() == "" {
		return fmt.Errorf("owner has empty UID")
	}
	gvk := owner.GroupVersionKind()
	ref := metav1.OwnerReference{
		APIVersion: gvk.GroupVersion().String(),
		Kind:       gvk.Kind,
		Name:       owner.GetName(),
		UID:        owner.GetUID(),
		Controller: boolPtr(true),
	}
	// Drop prior controller refs for same GVK/name
	existing := controlled.GetOwnerReferences()
	var next []metav1.OwnerReference
	for _, r := range existing {
		if r.UID == owner.GetUID() {
			continue
		}
		next = append(next, r)
	}
	next = append(next, ref)
	controlled.SetOwnerReferences(next)
	return nil
}

func boolPtr(b bool) *bool { return &b }

func (r *VirtualMachineIPAMReconciler) enrichClaimInterface(
	ctx context.Context,
	ip *kmcv1alpha1.IPAddress,
	att multusAttachment,
	hostname string,
) error {
	mac := strings.ToLower(strings.TrimSpace(att.MAC))
	if mac == "" && hostname == "" {
		return nil
	}
	curMAC := ""
	curHost := ""
	if ip.Spec.Interface != nil {
		curMAC = ip.Spec.Interface.MAC
		curHost = ip.Spec.Interface.Hostname
	}
	needMAC := mac != "" && curMAC == ""
	needHost := hostname != "" && curHost == ""
	if !needMAC && !needHost {
		return nil
	}
	before := ip.DeepCopy()
	if ip.Spec.Interface == nil {
		ip.Spec.Interface = &kmcv1alpha1.InterfaceBinding{}
	}
	if needMAC {
		ip.Spec.Interface.MAC = mac
	}
	if needHost {
		ip.Spec.Interface.Hostname = hostname
	}
	return r.Patch(ctx, ip, client.MergeFrom(before))
}

func (r *VirtualMachineIPAMReconciler) createGuestIPAddressClaim(
	ctx context.Context,
	vm *unstructured.Unstructured,
	address string,
	prefix int32,
	poolKind, poolName, mac, hostname string,
) error {
	name := ipam.AddressObjectName(address)
	ip := &kmcv1alpha1.IPAddress{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: vm.GetNamespace(),
			Labels: map[string]string{
				kmcv1alpha1.LabelManagedBy: kmcv1alpha1.ManagedByKMC,
				kmcv1alpha1.LabelAddress:   address,
				kmcv1alpha1.LabelPool:      poolName,
			},
		},
		Spec: kmcv1alpha1.IPAddressSpec{
			Address:      address,
			PrefixLength: prefix,
			PoolRef:      kmcv1alpha1.PoolReference{Kind: poolKind, Name: poolName},
			ClaimRef: &corev1.ObjectReference{
				APIVersion: "kubevirt.io/v1",
				Kind:       "VirtualMachine",
				Namespace:  vm.GetNamespace(),
				Name:       vm.GetName(),
				UID:        vm.GetUID(),
			},
		},
	}
	if mac != "" || hostname != "" {
		ip.Spec.Interface = &kmcv1alpha1.InterfaceBinding{
			MAC:      mac,
			Hostname: hostname,
		}
	}
	if err := setUnstructuredControllerReference(vm, ip); err != nil {
		return err
	}
	return r.Create(ctx, ip)
}

// resolvePoolForMultus returns pool kind/name, allocation window, and optional IPPool object.
func (r *VirtualMachineIPAMReconciler) resolvePoolForMultus(
	ctx context.Context,
	namespace, multusNetwork string,
) (poolKind, poolName string, window *ipam.PoolWindow, pool *kmcv1alpha1.IPPool, err error) {
	multusNetwork = strings.TrimSpace(multusNetwork)
	if multusNetwork == "" {
		return "", "", nil, nil, nil
	}

	// Static IPPool by Multus network match
	var list kmcv1alpha1.IPPoolList
	if err := r.List(ctx, &list); err != nil {
		return "", "", nil, nil, err
	}
	want := multusNetwork
	if i := strings.LastIndex(multusNetwork, "/"); i >= 0 {
		want = multusNetwork[i+1:]
	}
	for i := range list.Items {
		p := &list.Items[i]
		mn := strings.TrimSpace(p.Spec.MultusNetwork)
		base := mn
		if j := strings.LastIndex(mn, "/"); j >= 0 {
			base = mn[j+1:]
		}
		if mn == multusNetwork || base == want || p.Name == want {
			w, werr := ipam.ParsePoolWindow(p.Spec.CIDR, p.Spec.Gateway, p.Spec.Start, p.Spec.End, p.Spec.Exclude)
			if werr != nil {
				return "", "", nil, nil, fmt.Errorf("IPPool %q: %w", p.Name, werr)
			}
			return "IPPool", p.Name, w, p, nil
		}
	}

	// VPC in same namespace (Multus NAD name == VPC name)
	vpcName := want
	// If multus is other-ns/name, only match when ns is ours
	if i := strings.Index(multusNetwork, "/"); i > 0 {
		ns := multusNetwork[:i]
		if ns != namespace {
			return "", "", nil, nil, nil
		}
		vpcName = multusNetwork[i+1:]
	}
	var vpc kmcv1alpha1.VPC
	if getErr := r.Get(ctx, client.ObjectKey{Namespace: namespace, Name: vpcName}, &vpc); getErr != nil {
		if apierrors.IsNotFound(getErr) {
			return "", "", nil, nil, nil
		}
		return "", "", nil, nil, getErr
	}
	cidr := strings.TrimSpace(vpc.Spec.CIDR)
	if cidr == "" {
		// L2-only VPC: no IPAM
		return "", "", nil, nil, nil
	}
	w, werr := ipam.ParsePoolWindow(cidr, vpc.Spec.Gateway, "", "", nil)
	if werr != nil {
		return "", "", nil, nil, fmt.Errorf("VPC %q: %w", vpcName, werr)
	}
	return "VPC", vpcName, w, nil, nil
}

func (r *VirtualMachineIPAMReconciler) stampIPv4Annotations(
	ctx context.Context,
	vm *unstructured.Unstructured,
	addrs, pools []string,
) error {
	if len(addrs) == 0 {
		return nil
	}
	// Prefer full claim list for multi-attach order stability
	claims, err := r.listVMClaims(ctx, vm)
	if err != nil {
		return err
	}
	var ipv4Parts []string
	var poolParts []string
	for i := range claims {
		ip := &claims[i]
		if ip.Spec.Address == "" {
			continue
		}
		// Store address/prefix like console netplan annotations
		part := ip.Spec.Address
		if ip.Spec.PrefixLength > 0 {
			part = fmt.Sprintf("%s/%d", ip.Spec.Address, ip.Spec.PrefixLength)
		}
		ipv4Parts = append(ipv4Parts, part)
		poolParts = append(poolParts, ip.Spec.PoolRef.Name)
	}
	if len(ipv4Parts) == 0 {
		return nil
	}
	wantIPv4 := strings.Join(ipv4Parts, ",")
	wantPool := strings.Join(poolParts, ",")

	ann := vm.GetAnnotations()
	if ann == nil {
		ann = map[string]string{}
	}
	if ann[annotationGuestIPv4] == wantIPv4 && ann[annotationGuestIPAMPool] == wantPool {
		return nil
	}

	before := vm.DeepCopy()
	ann[annotationGuestIPv4] = wantIPv4
	ann[annotationGuestIPAMPool] = wantPool
	vm.SetAnnotations(ann)
	return r.Patch(ctx, vm, client.MergeFrom(before))
}

// SetupWithManager registers the controller.
func (r *VirtualMachineIPAMReconciler) SetupWithManager(mgr ctrl.Manager) error {
	vm := newVMUnstructured("", "")
	return ctrl.NewControllerManagedBy(mgr).
		// Watch VirtualMachines (unstructured GVK)
		For(vm).
		// Reconcile when a claim changes (MAC / delete)
		Watches(&kmcv1alpha1.IPAddress{}, handler.EnqueueRequestsFromMapFunc(r.mapIPAddressToVM)).
		Named("virtualmachine-ipam").
		Complete(r)
}

func (r *VirtualMachineIPAMReconciler) mapIPAddressToVM(ctx context.Context, obj client.Object) []reconcile.Request {
	ip, ok := obj.(*kmcv1alpha1.IPAddress)
	if !ok {
		return nil
	}
	ref := ip.Spec.ClaimRef
	if ref == nil || !strings.EqualFold(ref.Kind, "VirtualMachine") || ref.Name == "" {
		return nil
	}
	ns := ref.Namespace
	if ns == "" {
		ns = ip.Namespace
	}
	return []reconcile.Request{{
		NamespacedName: types.NamespacedName{Namespace: ns, Name: ref.Name},
	}}
}
