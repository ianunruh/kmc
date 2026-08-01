package controller

import (
	"context"
	"strings"

	"sigs.k8s.io/controller-runtime/pkg/client"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	rt "github.com/ianunruh/kmc/internal/router"
)

// buildPolicyDoc renders the full policy document from resolved interfaces + cluster CRs.
func (r *RouterReconciler) buildPolicyDoc(
	ctx context.Context,
	obj *kmcv1alpha1.Router,
	ifaces []resolvedInterface,
	ext *resolvedExternal,
	prevGen int64,
) (*rt.PolicyDoc, error) {
	doc := rt.EmptyPolicyDoc(obj.Name, obj.Namespace)
	if prevGen > 0 {
		doc.Metadata.Generation = prevGen
	}

	doc.Interfaces = make([]rt.PolicyInterface, 0, len(ifaces))
	attached := map[string]struct{}{}
	for _, iface := range ifaces {
		attached[iface.VPC] = struct{}{}
		doc.Interfaces = append(doc.Interfaces, rt.PolicyInterface{
			VPC:     iface.VPC,
			CIDR:    iface.CIDR,
			Gateway: iface.Gateway,
			MAC:     iface.MAC,
			Domain:  iface.Domain,
			DHCP:    rt.DefaultDHCP(),
		})
	}

	if ext != nil {
		doc.External = &rt.PolicyExternal{
			MultusNetwork: ext.MultusNetwork,
			PrimaryCIDR:   ext.PrimaryCIDR,
			Gateway:       ext.Gateway,
			MAC:           ext.MAC,
			SNAT:          ext.SNAT,
		}
	} else {
		doc.External = nil
	}

	leases, err := r.projectLeases(ctx, obj.Namespace, attached)
	if err != nil {
		return nil, err
	}
	doc.Leases = leases

	fips, err := r.projectFloatingIPs(ctx, obj, attached)
	if err != nil {
		return nil, err
	}
	doc.FloatingIPs = fips

	pfs, err := r.projectPortForwards(ctx, obj, attached)
	if err != nil {
		return nil, err
	}
	doc.PortForwards = pfs

	// Conflict: public address used as full FIP association and port-forward host.
	associatedPublic := map[string]struct{}{}
	for _, f := range doc.FloatingIPs {
		if strings.TrimSpace(f.Private) != "" {
			associatedPublic[f.Public] = struct{}{}
		}
	}
	filteredPF := doc.PortForwards[:0]
	for _, pf := range doc.PortForwards {
		if _, ok := associatedPublic[pf.Public]; ok {
			continue // skip conflicting PF (FIP wins)
		}
		filteredPF = append(filteredPF, pf)
	}
	doc.PortForwards = filteredPF

	return &doc, nil
}

func (r *RouterReconciler) projectLeases(ctx context.Context, namespace string, attached map[string]struct{}) ([]rt.PolicyLease, error) {
	var list kmcv1alpha1.IPAddressList
	if err := r.List(ctx, &list, client.InNamespace(namespace)); err != nil {
		return nil, err
	}
	var out []rt.PolicyLease
	for i := range list.Items {
		ip := &list.Items[i]
		if ip.Spec.PoolRef.Kind != "VPC" {
			continue
		}
		vpc := strings.TrimSpace(ip.Spec.PoolRef.Name)
		if _, ok := attached[vpc]; !ok {
			continue
		}
		if ip.Spec.Interface == nil || strings.TrimSpace(ip.Spec.Interface.MAC) == "" {
			continue
		}
		// Skip router gateway claims (claimRef Router, no guest interface typically —
		// but if MAC is set only for guests we already require interface.mac).
		if ip.Spec.ClaimRef != nil && ip.Spec.ClaimRef.Kind == "Router" {
			continue
		}
		hostname := strings.TrimSpace(ip.Spec.Interface.Hostname)
		vm := ""
		if ip.Spec.ClaimRef != nil && ip.Spec.ClaimRef.Kind == "VirtualMachine" {
			vm = ip.Spec.ClaimRef.Name
		}
		if hostname == "" {
			hostname = vm
		}
		if hostname == "" {
			hostname = "host"
		}
		out = append(out, rt.PolicyLease{
			VPC:      vpc,
			MAC:      strings.ToLower(strings.TrimSpace(ip.Spec.Interface.MAC)),
			IP:       strings.TrimSpace(ip.Spec.Address),
			Hostname: hostname,
			VM:       vm,
		})
	}
	return out, nil
}

func (r *RouterReconciler) projectFloatingIPs(ctx context.Context, obj *kmcv1alpha1.Router, attached map[string]struct{}) ([]rt.PolicyFloatingIP, error) {
	var list kmcv1alpha1.FloatingIPList
	if err := r.List(ctx, &list, client.InNamespace(obj.Namespace)); err != nil {
		return nil, err
	}
	var out []rt.PolicyFloatingIP
	for i := range list.Items {
		fip := &list.Items[i]
		vpc := strings.TrimSpace(fip.Spec.VPCRef.Name)
		if _, ok := attached[vpc]; !ok {
			continue
		}
		if fip.Spec.RouterRef != nil {
			if n := strings.TrimSpace(fip.Spec.RouterRef.Name); n != "" && n != obj.Name {
				continue
			}
		}
		public := strings.TrimSpace(fip.Status.Address)
		if public == "" {
			public = strings.TrimSpace(fip.Spec.Address)
		}
		if public == "" {
			continue
		}
		prefix := int(fip.Status.PrefixLength)
		if prefix == 0 {
			prefix = 32
		}
		entry := rt.PolicyFloatingIP{
			ID:     rt.FloatingIPID(public),
			Public: public,
			Prefix: prefix,
			VPC:    vpc,
		}
		if priv := strings.TrimSpace(fip.Spec.PrivateAddress); priv != "" {
			entry.Private = priv
		}
		if fip.Spec.TargetVM != nil {
			entry.TargetVM = strings.TrimSpace(fip.Spec.TargetVM.Name)
		}
		out = append(out, entry)
	}
	return out, nil
}

func (r *RouterReconciler) projectPortForwards(ctx context.Context, obj *kmcv1alpha1.Router, attached map[string]struct{}) ([]rt.PolicyPortForward, error) {
	var list kmcv1alpha1.PortForwardList
	if err := r.List(ctx, &list, client.InNamespace(obj.Namespace)); err != nil {
		return nil, err
	}
	var out []rt.PolicyPortForward
	for i := range list.Items {
		pf := &list.Items[i]
		vpc := strings.TrimSpace(pf.Spec.VPCRef.Name)
		if _, ok := attached[vpc]; !ok {
			continue
		}
		if pf.Spec.RouterRef != nil {
			if n := strings.TrimSpace(pf.Spec.RouterRef.Name); n != "" && n != obj.Name {
				continue
			}
		}
		public := strings.TrimSpace(pf.Spec.PublicAddress)
		proto := strings.ToUpper(strings.TrimSpace(pf.Spec.Protocol))
		entry := rt.PolicyPortForward{
			ID:          rt.PortForwardID(public, proto, pf.Spec.PublicPort),
			Public:      public,
			PublicPort:  pf.Spec.PublicPort,
			Private:     strings.TrimSpace(pf.Spec.PrivateAddress),
			PrivatePort: pf.Spec.PrivatePort,
			Protocol:    proto,
			VPC:         vpc,
		}
		if pf.Spec.TargetVM != nil {
			entry.TargetVM = strings.TrimSpace(pf.Spec.TargetVM.Name)
		}
		out = append(out, entry)
	}
	return out, nil
}

// nextPolicyGeneration returns prev+1 when desired content changed, else prev.
func nextPolicyGeneration(prev *rt.PolicyDoc, next *rt.PolicyDoc) int64 {
	if prev == nil {
		if next.Metadata.Generation > 0 {
			return next.Metadata.Generation
		}
		return 1
	}
	if rt.PolicyEqualDesired(prev, next) {
		return prev.Metadata.Generation
	}
	g := prev.Metadata.Generation + 1
	if g < 1 {
		g = 1
	}
	return g
}

func statusInterfaces(ifaces []resolvedInterface) []kmcv1alpha1.RouterInterfaceStatus {
	out := make([]kmcv1alpha1.RouterInterfaceStatus, 0, len(ifaces))
	for _, iface := range ifaces {
		out = append(out, kmcv1alpha1.RouterInterfaceStatus{
			VPC:     iface.VPC,
			CIDR:    iface.CIDR,
			Gateway: iface.Gateway,
			MAC:     iface.MAC,
			Domain:  iface.Domain,
		})
	}
	return out
}

func statusExternal(ext *resolvedExternal) *kmcv1alpha1.RouterExternalStatus {
	if ext == nil {
		return nil
	}
	return &kmcv1alpha1.RouterExternalStatus{
		MultusNetwork: ext.MultusNetwork,
		PrimaryCIDR:   ext.PrimaryCIDR,
		Gateway:       ext.Gateway,
		MAC:           ext.MAC,
		SNAT:          ext.SNAT,
	}
}

func ifaceSummary(ifaces []resolvedInterface) string {
	if len(ifaces) == 0 {
		return ""
	}
	names := make([]string, 0, len(ifaces))
	for _, i := range ifaces {
		names = append(names, i.VPC)
	}
	return strings.Join(names, ",")
}