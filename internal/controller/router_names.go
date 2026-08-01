package controller

import (
	"fmt"
	"regexp"
	"strings"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	"github.com/ianunruh/kmc/internal/ipam"
	rt "github.com/ianunruh/kmc/internal/router"
)

var dns1123Label = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

func validateRouterSpec(obj *kmcv1alpha1.Router) error {
	if obj == nil {
		return fmt.Errorf("router is nil")
	}
	name := strings.TrimSpace(obj.Name)
	if name == "" || len(name) > 63 || !dns1123Label.MatchString(name) {
		return fmt.Errorf("metadata.name must be a DNS-1123 label (≤63 chars)")
	}
	if len(obj.Spec.VPCs) == 0 {
		return fmt.Errorf("spec.vpcs requires at least one attachment")
	}
	seen := make(map[string]struct{}, len(obj.Spec.VPCs))
	for i, att := range obj.Spec.VPCs {
		n := strings.TrimSpace(att.Name)
		if n == "" {
			return fmt.Errorf("spec.vpcs[%d].name is required", i)
		}
		if _, ok := seen[n]; ok {
			return fmt.Errorf("spec.vpcs: duplicate VPC %q", n)
		}
		seen[n] = struct{}{}
		if gw := strings.TrimSpace(att.Gateway); gw != "" {
			if err := ipam.ValidateIPv4Address(gw); err != nil {
				return fmt.Errorf("spec.vpcs[%d].gateway: %w", i, err)
			}
		}
	}
	budget := len(obj.Spec.VPCs)
	if obj.Spec.External != nil && strings.TrimSpace(obj.Spec.External.MultusNetwork) != "" {
		budget++
		if addr := strings.TrimSpace(obj.Spec.External.Address); addr != "" {
			if err := ipam.ValidateIPv4Address(addr); err != nil {
				return fmt.Errorf("spec.external.address: %w", err)
			}
		}
	}
	if budget > kmcv1alpha1.MaxMultusAttachments {
		return fmt.Errorf("at most %d Multus NICs (VPCs + optional external) are supported", kmcv1alpha1.MaxMultusAttachments)
	}

	app := obj.Spec.Appliance
	if strings.TrimSpace(app.Image.Name) == "" || strings.TrimSpace(app.Image.Namespace) == "" {
		return fmt.Errorf("spec.appliance.image.namespace and name are required")
	}
	if strings.TrimSpace(app.DiskSize) == "" {
		return fmt.Errorf("spec.appliance.diskSize is required")
	}
	if len(app.SSHPublicKeys) == 0 {
		return fmt.Errorf("spec.appliance.sshPublicKeys requires at least one key")
	}
	hasKey := false
	for _, k := range app.SSHPublicKeys {
		if strings.TrimSpace(k) != "" {
			hasKey = true
			break
		}
	}
	if !hasKey {
		return fmt.Errorf("spec.appliance.sshPublicKeys requires at least one key")
	}
	if strings.TrimSpace(app.InstanceType) == "" {
		if app.CPUCores == nil || *app.CPUCores < 1 {
			return fmt.Errorf("spec.appliance: provide instanceType or cpuCores")
		}
		if strings.TrimSpace(app.Memory) == "" {
			return fmt.Errorf("spec.appliance: provide instanceType or memory")
		}
	}
	return nil
}

func routerManagedLabels(routerName string) map[string]string {
	return map[string]string{
		kmcv1alpha1.LabelManagedBy: kmcv1alpha1.ManagedByKMC,
		kmcv1alpha1.LabelResource:  kmcv1alpha1.ResourceRouterPolicy,
		kmcv1alpha1.LabelRouter:    strings.TrimSpace(routerName),
		kmcv1alpha1.LabelRole:      kmcv1alpha1.RoleRouter,
	}
}

func routerApplianceLabels(routerName string) map[string]string {
	return map[string]string{
		kmcv1alpha1.LabelManagedBy: kmcv1alpha1.ManagedByKMC,
		kmcv1alpha1.LabelRole:      kmcv1alpha1.RoleRouter,
		kmcv1alpha1.LabelRouter:    strings.TrimSpace(routerName),
	}
}

// policyConfigMapName is an alias for package-local use.
func policyConfigMapName(routerName string) string {
	return rt.ConfigMapName(routerName)
}
