package controller

import (
	"context"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	"github.com/ianunruh/kmc/internal/ipam"
)

// resolvedInterface is a fully resolved private attachment for policy + status.
type resolvedInterface struct {
	VPC     string
	CIDR    string
	Gateway string
	MAC     string
	Domain  string
	Prefix  int32
}

// resolvedExternal is the optional public gateway.
type resolvedExternal struct {
	MultusNetwork string
	Address       string
	Prefix        int32
	PrimaryCIDR   string
	Gateway       string
	MAC           string
	SNAT          bool
}

func (r *RouterReconciler) resolveAndClaimInterfaces(ctx context.Context, obj *kmcv1alpha1.Router) ([]resolvedInterface, error) {
	// Preserve MACs from status when VPC still attached.
	macByVPC := map[string]string{}
	for _, iface := range obj.Status.Interfaces {
		if iface.VPC != "" && iface.MAC != "" {
			macByVPC[iface.VPC] = strings.ToLower(iface.MAC)
		}
	}

	out := make([]resolvedInterface, 0, len(obj.Spec.VPCs))
	seenCIDRs := map[string]struct{}{}

	for _, att := range obj.Spec.VPCs {
		vpcName := strings.TrimSpace(att.Name)
		cidr, vpcGateway, err := r.loadVPCNetwork(ctx, obj.Namespace, vpcName)
		if err != nil {
			return nil, err
		}
		if cidr == "" {
			return nil, fmt.Errorf("VPC %s/%s requires private IPAM (CIDR)", obj.Namespace, vpcName)
		}
		if _, ok := seenCIDRs[cidr]; ok {
			return nil, fmt.Errorf("attached VPCs must have distinct CIDRs (duplicate %s)", cidr)
		}
		seenCIDRs[cidr] = struct{}{}

		gateway := strings.TrimSpace(att.Gateway)
		if gateway == "" {
			gateway = strings.TrimSpace(vpcGateway)
		}
		if gateway == "" {
			gateway, err = ipam.FirstUsableHost(cidr)
			if err != nil {
				return nil, fmt.Errorf("VPC %s gateway: %w", vpcName, err)
			}
		}
		network, err := ipam.ParseIPv4CIDR(cidr)
		if err != nil {
			return nil, fmt.Errorf("VPC %s cidr: %w", vpcName, err)
		}
		if !ipam.ContainsIPv4(network, gateway) {
			return nil, fmt.Errorf("gateway %s is outside %s", gateway, cidr)
		}
		ones, _ := network.Mask.Size()
		prefix := int32(ones)

		// Claim gateway IPAddress
		if err := r.ensureGatewayIPAddress(ctx, obj, vpcName, gateway, prefix); err != nil {
			return nil, err
		}

		mac := macByVPC[vpcName]
		if mac == "" {
			mac, err = ipam.GenerateLocalMAC()
			if err != nil {
				return nil, err
			}
		}

		// Stamp NAD router annotation + gateway/dns
		if err := r.stampVPCRouterMetadata(ctx, obj.Namespace, vpcName, obj.Name, gateway, cidr); err != nil {
			return nil, err
		}

		out = append(out, resolvedInterface{
			VPC:     vpcName,
			CIDR:    cidr,
			Gateway: gateway,
			MAC:     mac,
			Domain:  defaultRouterDomain(vpcName),
			Prefix:  prefix,
		})
	}

	// Clear annotations on VPCs no longer in spec (that we previously owned).
	for _, prev := range obj.Status.Interfaces {
		still := false
		for _, cur := range out {
			if cur.VPC == prev.VPC {
				still = true
				break
			}
		}
		if !still && prev.VPC != "" {
			_ = r.clearVPCRouterAnnotation(ctx, obj.Namespace, prev.VPC, obj.Name)
		}
	}

	return out, nil
}

func defaultRouterDomain(vpcName string) string {
	return strings.TrimSpace(vpcName) + ".vpc.local"
}

func (r *RouterReconciler) loadVPCNetwork(ctx context.Context, namespace, vpcName string) (cidr, gateway string, err error) {
	var vpc kmcv1alpha1.VPC
	if err := r.Get(ctx, client.ObjectKey{Namespace: namespace, Name: vpcName}, &vpc); err != nil {
		if apierrors.IsNotFound(err) {
			// Fall back to Multus NAD annotations (console-created VPCs without CR).
			return r.loadVPCFromNAD(ctx, namespace, vpcName)
		}
		return "", "", err
	}
	cidr = strings.TrimSpace(vpc.Spec.CIDR)
	gateway = strings.TrimSpace(vpc.Spec.Gateway)
	if cidr == "" {
		// Try NAD annotations for hybrid
		c2, g2, nerr := r.loadVPCFromNAD(ctx, namespace, vpcName)
		if nerr == nil && c2 != "" {
			return c2, g2, nil
		}
	}
	return cidr, gateway, nil
}

func (r *RouterReconciler) loadVPCFromNAD(ctx context.Context, namespace, vpcName string) (cidr, gateway string, err error) {
	nad := newNADUnstructured(namespace, vpcName)
	if err := r.Get(ctx, client.ObjectKey{Namespace: namespace, Name: vpcName}, nad); err != nil {
		if apierrors.IsNotFound(err) {
			return "", "", fmt.Errorf("VPC %s/%s not found", namespace, vpcName)
		}
		return "", "", err
	}
	ann := nad.GetAnnotations()
	if ann == nil {
		return "", "", fmt.Errorf("VPC %s/%s has no network annotations", namespace, vpcName)
	}
	return strings.TrimSpace(ann[kmcv1alpha1.AnnotationCIDR]),
		strings.TrimSpace(ann[kmcv1alpha1.AnnotationGateway]),
		nil
}

func (r *RouterReconciler) ensureGatewayIPAddress(ctx context.Context, obj *kmcv1alpha1.Router, vpcName, address string, prefix int32) error {
	name := ipam.AddressObjectName(address)
	ip := &kmcv1alpha1.IPAddress{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: obj.Namespace,
		},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, ip, func() error {
		// If claimed by someone else, refuse.
		if ip.UID != "" && ip.Spec.ClaimRef != nil {
			ref := ip.Spec.ClaimRef
			if ref.Kind != "Router" || ref.Name != obj.Name {
				return fmt.Errorf("address %s already claimed by %s/%s", address, ref.Kind, ref.Name)
			}
		}
		ip.Labels = mergeLabels(ip.Labels, map[string]string{
			kmcv1alpha1.LabelManagedBy: kmcv1alpha1.ManagedByKMC,
			kmcv1alpha1.LabelAddress:   address,
			kmcv1alpha1.LabelPool:      vpcName,
			kmcv1alpha1.LabelRouter:    obj.Name,
		})
		ip.Spec.Address = address
		ip.Spec.PrefixLength = prefix
		ip.Spec.PoolRef = kmcv1alpha1.PoolReference{Kind: "VPC", Name: vpcName}
		ip.Spec.ClaimRef = &corev1.ObjectReference{
			APIVersion: kmcv1alpha1.GroupVersion.String(),
			Kind:       "Router",
			Name:       obj.Name,
			Namespace:  obj.Namespace,
			UID:        obj.UID,
		}
		return controllerutil.SetControllerReference(obj, ip, r.Scheme)
	})
	if err != nil {
		if apierrors.IsAlreadyExists(err) {
			// Race: re-get and check ownership
			var existing kmcv1alpha1.IPAddress
			if getErr := r.Get(ctx, client.ObjectKey{Namespace: obj.Namespace, Name: name}, &existing); getErr != nil {
				return getErr
			}
			if existing.Spec.ClaimRef != nil &&
				existing.Spec.ClaimRef.Kind == "Router" &&
				existing.Spec.ClaimRef.Name == obj.Name {
				return nil
			}
			return fmt.Errorf("address %s is already claimed", address)
		}
		return err
	}
	return nil
}

func (r *RouterReconciler) resolveAndClaimExternal(ctx context.Context, obj *kmcv1alpha1.Router) (*resolvedExternal, error) {
	if obj.Spec.External == nil || strings.TrimSpace(obj.Spec.External.MultusNetwork) == "" {
		return nil, nil
	}
	multus := strings.TrimSpace(obj.Spec.External.MultusNetwork)
	pool, err := r.findIPPoolForMultus(ctx, multus)
	if err != nil {
		return nil, err
	}
	if pool == nil {
		return nil, fmt.Errorf("no IPPool found for Multus network %q", multus)
	}
	// Ensure shared Multus NAD exists in the router namespace (from IPPool.spec.cni).
	if err := ensureStaticNADForPool(ctx, r.Client, r.Scheme, obj.Namespace, pool); err != nil {
		return nil, fmt.Errorf("ensure static Multus NAD: %w", err)
	}
	if strings.TrimSpace(pool.Spec.Gateway) == "" {
		return nil, fmt.Errorf("public pool %q needs a gateway for the external default route", pool.Name)
	}

	window, err := ipam.ParsePoolWindow(pool.Spec.CIDR, pool.Spec.Gateway, pool.Spec.Start, pool.Spec.End, pool.Spec.Exclude)
	if err != nil {
		return nil, fmt.Errorf("IPPool %q: %w", pool.Name, err)
	}
	prefix := window.PrefixLength()

	// Prefer status external address, then spec, then allocate.
	preferred := ""
	if obj.Status.External != nil {
		preferred = addressFromCIDRHost(obj.Status.External.PrimaryCIDR)
	}
	if preferred == "" {
		preferred = strings.TrimSpace(obj.Spec.External.Address)
	}

	address, err := r.ensurePublicIPAddress(ctx, obj, pool, preferred, window)
	if err != nil {
		return nil, err
	}

	mac := ""
	if obj.Status.External != nil {
		mac = strings.ToLower(strings.TrimSpace(obj.Status.External.MAC))
	}
	if mac == "" {
		mac, err = ipam.GenerateLocalMAC()
		if err != nil {
			return nil, err
		}
	}

	snat := true
	if obj.Spec.External.SNAT != nil {
		snat = *obj.Spec.External.SNAT
	}

	return &resolvedExternal{
		MultusNetwork: multus,
		Address:       address,
		Prefix:        prefix,
		PrimaryCIDR:   fmt.Sprintf("%s/%d", address, prefix),
		Gateway:       strings.TrimSpace(pool.Spec.Gateway),
		MAC:           mac,
		SNAT:          snat,
	}, nil
}

func addressFromCIDRHost(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if i := strings.IndexByte(s, '/'); i >= 0 {
		return s[:i]
	}
	return s
}

func (r *RouterReconciler) findIPPoolForMultus(ctx context.Context, multus string) (*kmcv1alpha1.IPPool, error) {
	multus = strings.TrimSpace(multus)
	// Try pool name match first.
	var byName kmcv1alpha1.IPPool
	if err := r.Get(ctx, client.ObjectKey{Name: multus}, &byName); err == nil {
		return &byName, nil
	} else if !apierrors.IsNotFound(err) {
		return nil, err
	}

	var list kmcv1alpha1.IPPoolList
	if err := r.List(ctx, &list); err != nil {
		return nil, err
	}
	// Normalize multus: accept "ns/name" or "name"
	want := multus
	if i := strings.LastIndex(multus, "/"); i >= 0 {
		want = multus[i+1:]
	}
	for i := range list.Items {
		p := &list.Items[i]
		mn := strings.TrimSpace(p.Spec.MultusNetwork)
		base := mn
		if j := strings.LastIndex(mn, "/"); j >= 0 {
			base = mn[j+1:]
		}
		if mn == multus || base == want || p.Name == want {
			return p, nil
		}
	}
	return nil, nil
}

func (r *RouterReconciler) ensurePublicIPAddress(
	ctx context.Context,
	obj *kmcv1alpha1.Router,
	pool *kmcv1alpha1.IPPool,
	preferred string,
	window *ipam.PoolWindow,
) (string, error) {
	used, err := listUsedAddressesByPool(ctx, r.Client, "IPPool", pool.Name)
	if err != nil {
		return "", err
	}
	address, _, err := allocateIPAddressFromWindow(
		ctx,
		r.Client,
		obj.Namespace,
		window,
		"IPPool",
		pool.Name,
		preferred,
		used,
		func(ip *kmcv1alpha1.IPAddress) bool { return isClaimedByRouter(ip, obj) },
		func(ctx context.Context, address string, prefix int32) error {
			return r.createRouterIPAddressClaim(ctx, obj, address, prefix, "IPPool", pool.Name)
		},
	)
	return address, err
}

func (r *RouterReconciler) createRouterIPAddressClaim(
	ctx context.Context,
	obj *kmcv1alpha1.Router,
	address string,
	prefix int32,
	poolKind, poolName string,
) error {
	name := ipam.AddressObjectName(address)
	ip := &kmcv1alpha1.IPAddress{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: obj.Namespace,
			Labels: map[string]string{
				kmcv1alpha1.LabelManagedBy: kmcv1alpha1.ManagedByKMC,
				kmcv1alpha1.LabelAddress:   address,
				kmcv1alpha1.LabelPool:      poolName,
				kmcv1alpha1.LabelRouter:    obj.Name,
			},
		},
		Spec: kmcv1alpha1.IPAddressSpec{
			Address:      address,
			PrefixLength: prefix,
			PoolRef:      kmcv1alpha1.PoolReference{Kind: poolKind, Name: poolName},
			ClaimRef: &corev1.ObjectReference{
				APIVersion: kmcv1alpha1.GroupVersion.String(),
				Kind:       "Router",
				Name:       obj.Name,
				Namespace:  obj.Namespace,
				UID:        obj.UID,
			},
		},
	}
	if err := controllerutil.SetControllerReference(obj, ip, r.Scheme); err != nil {
		return err
	}
	return r.Create(ctx, ip)
}

func isClaimedByRouter(ip *kmcv1alpha1.IPAddress, router *kmcv1alpha1.Router) bool {
	for _, ref := range ip.GetOwnerReferences() {
		if ref.UID == router.UID {
			return true
		}
	}
	ref := ip.Spec.ClaimRef
	if ref == nil {
		return false
	}
	return ref.Kind == "Router" && ref.Name == router.Name &&
		(ref.Namespace == "" || ref.Namespace == router.Namespace)
}

func (r *RouterReconciler) deleteOwnedIPAddresses(ctx context.Context, obj *kmcv1alpha1.Router) error {
	var list kmcv1alpha1.IPAddressList
	if err := r.List(ctx, &list, client.InNamespace(obj.Namespace)); err != nil {
		return err
	}
	for i := range list.Items {
		ip := &list.Items[i]
		if !isClaimedByRouter(ip, obj) {
			continue
		}
		if err := r.Delete(ctx, ip); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}
