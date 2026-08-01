package controller

import (
	"context"
	"strings"

	"sigs.k8s.io/controller-runtime/pkg/client"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
)

// routerProgramming describes whether a Router is projecting and applying rules.
type routerProgramming struct {
	Name       string
	Found      bool
	// PolicyReady: control plane has rendered policy for attached VPC.
	PolicyReady bool
	// AgentReady: in-guest agent reports Ready.
	AgentReady bool
}

// lookupRouterForVPC finds a Router that should program rules for vpcName.
// Prefer explicit routerRef; else first Router in the namespace attaching the VPC.
func lookupRouterForVPC(
	ctx context.Context,
	c client.Client,
	namespace, vpcName string,
	routerRefName string,
) (routerProgramming, error) {
	vpcName = strings.TrimSpace(vpcName)
	routerRefName = strings.TrimSpace(routerRefName)

	if routerRefName != "" {
		var rt kmcv1alpha1.Router
		if err := c.Get(ctx, client.ObjectKey{Namespace: namespace, Name: routerRefName}, &rt); err != nil {
			return routerProgramming{Name: routerRefName, Found: false}, client.IgnoreNotFound(err)
		}
		return programmingFromRouter(&rt, vpcName), nil
	}

	if vpcName == "" {
		return routerProgramming{}, nil
	}

	var list kmcv1alpha1.RouterList
	if err := c.List(ctx, &list, client.InNamespace(namespace)); err != nil {
		return routerProgramming{}, err
	}
	for i := range list.Items {
		rt := &list.Items[i]
		if routerAttachesVPC(rt, vpcName) {
			return programmingFromRouter(rt, vpcName), nil
		}
	}
	return routerProgramming{}, nil
}

func routerAttachesVPC(rt *kmcv1alpha1.Router, vpcName string) bool {
	for _, att := range rt.Spec.VPCs {
		if strings.TrimSpace(att.Name) == vpcName {
			return true
		}
	}
	// Also accept status interfaces (observed).
	for _, iface := range rt.Status.Interfaces {
		if strings.TrimSpace(iface.VPC) == vpcName {
			return true
		}
	}
	return false
}

func programmingFromRouter(rt *kmcv1alpha1.Router, vpcName string) routerProgramming {
	out := routerProgramming{Name: rt.Name, Found: true}
	if !routerAttachesVPC(rt, vpcName) && vpcName != "" {
		// Explicit ref but VPC not attached — treat as found but not policy-ready.
		return out
	}
	if rt.Status.PolicyConfigMap != "" && rt.Status.PolicyGeneration > 0 {
		out.PolicyReady = true
	}
	if rt.Status.Agent != nil && strings.EqualFold(rt.Status.Agent.Status, "Ready") {
		out.AgentReady = true
	}
	// Control-plane-only readiness when agent skipped / pending still allows programmed=true.
	if !out.PolicyReady {
		for _, c := range rt.Status.Conditions {
			if c.Type == kmcv1alpha1.RouterConditionPolicy && c.Status == "True" {
				out.PolicyReady = true
			}
			if c.Type == kmcv1alpha1.RouterConditionControlPlane && c.Status == "True" {
				out.PolicyReady = true
			}
		}
	}
	return out
}
