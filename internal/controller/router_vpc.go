package controller

import (
	"context"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
)

// stampVPCRouterMetadata sets NAD annotations for router attachment (console parity).
func (r *RouterReconciler) stampVPCRouterMetadata(ctx context.Context, namespace, vpcName, routerName, gateway, cidr string) error {
	nad := newNADUnstructured(namespace, vpcName)
	if err := r.Get(ctx, client.ObjectKey{Namespace: namespace, Name: vpcName}, nad); err != nil {
		if apierrors.IsNotFound(err) {
			// VPC CR may exist without NAD yet; skip until NAD appears.
			return nil
		}
		return err
	}
	ann := nad.GetAnnotations()
	if ann == nil {
		ann = map[string]string{}
	}
	// Refuse if another router owns this VPC.
	if existing := strings.TrimSpace(ann[kmcv1alpha1.AnnotationRouter]); existing != "" && existing != routerName {
		return fmt.Errorf("VPC %s is already attached to router %s", vpcName, existing)
	}

	before := nad.DeepCopy()
	ann[kmcv1alpha1.AnnotationRouter] = routerName
	if cidr != "" {
		ann[kmcv1alpha1.AnnotationCIDR] = cidr
	}
	if gateway != "" {
		ann[kmcv1alpha1.AnnotationGateway] = gateway
		ann[kmcv1alpha1.AnnotationDNS] = gateway
	}
	nad.SetAnnotations(ann)
	return r.Patch(ctx, nad, client.MergeFrom(before))
}

func (r *RouterReconciler) clearVPCRouterAnnotation(ctx context.Context, namespace, vpcName, routerName string) error {
	nad := newNADUnstructured(namespace, vpcName)
	if err := r.Get(ctx, client.ObjectKey{Namespace: namespace, Name: vpcName}, nad); err != nil {
		if apierrors.IsNotFound(err) {
			return nil
		}
		return err
	}
	ann := nad.GetAnnotations()
	if ann == nil {
		return nil
	}
	if strings.TrimSpace(ann[kmcv1alpha1.AnnotationRouter]) != routerName {
		return nil
	}
	before := nad.DeepCopy()
	delete(ann, kmcv1alpha1.AnnotationRouter)
	nad.SetAnnotations(ann)
	return r.Patch(ctx, nad, client.MergeFrom(before))
}

func (r *RouterReconciler) clearAllVPCRouterAnnotations(ctx context.Context, obj *kmcv1alpha1.Router) error {
	for _, iface := range obj.Status.Interfaces {
		if iface.VPC == "" {
			continue
		}
		if err := r.clearVPCRouterAnnotation(ctx, obj.Namespace, iface.VPC, obj.Name); err != nil {
			return err
		}
	}
	// Also clear any still listed in spec (status may be empty on partial create).
	for _, att := range obj.Spec.VPCs {
		if n := strings.TrimSpace(att.Name); n != "" {
			if err := r.clearVPCRouterAnnotation(ctx, obj.Namespace, n, obj.Name); err != nil {
				return err
			}
		}
	}
	return nil
}
