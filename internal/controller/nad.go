package controller

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
)

// Multus NetworkAttachmentDefinition GVK (k8s.cni.cncf.io/v1).
var nadGVK = schema.GroupVersionKind{
	Group:   "k8s.cni.cncf.io",
	Version: "v1",
	Kind:    "NetworkAttachmentDefinition",
}

func newNADUnstructured(namespace, name string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetGroupVersionKind(nadGVK)
	u.SetNamespace(namespace)
	u.SetName(name)
	return u
}

// bridgeCNIConfig builds Multus bridge + vlan CNI JSON (no CNI IPAM).
func bridgeCNIConfig(name, bridge string, vlan int32) (string, error) {
	cfg := map[string]any{
		"cniVersion": "0.3.1",
		"name":       name,
		"type":       "bridge",
		"bridge":     bridge,
		"vlan":       vlan,
		"ipam":       map[string]any{},
	}
	b, err := json.Marshal(cfg)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// staticPoolCNIConfig builds Multus CNI JSON from an IPPool CNI template.
func staticPoolCNIConfig(nadName string, cni *kmcv1alpha1.IPPoolCNISpec) (string, error) {
	if cni == nil {
		return "", fmt.Errorf("cni is required")
	}
	typ := strings.TrimSpace(cni.Type)
	bridge := strings.TrimSpace(cni.Bridge)
	if typ == "" || bridge == "" {
		return "", fmt.Errorf("cni.type and cni.bridge are required")
	}
	cfg := map[string]any{
		"cniVersion": "0.3.1",
		"name":       nadName,
		"type":       typ,
		"bridge":     bridge,
		"ipam":       map[string]any{},
	}
	if cni.VLAN != nil {
		cfg["vlan"] = *cni.VLAN
	}
	b, err := json.Marshal(cfg)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// nadNameFromMultusNetwork returns the bare Multus NAD name
// (`ns/bridge-external` or `bridge-external` → `bridge-external`).
func nadNameFromMultusNetwork(multus string) string {
	raw := strings.TrimSpace(multus)
	if raw == "" {
		return ""
	}
	if i := strings.LastIndex(raw, "/"); i >= 0 {
		return raw[i+1:]
	}
	return raw
}

// multusCrossNamespace reports whether multusNetwork names another namespace
// relative to the consumer namespace (operator-managed; do not ensure).
func multusCrossNamespace(multus, consumerNS string) bool {
	raw := strings.TrimSpace(multus)
	slash := strings.Index(raw, "/")
	if slash <= 0 {
		return false
	}
	ns := raw[:slash]
	return ns != "" && ns != strings.TrimSpace(consumerNS)
}

// ensureStaticNADForPool materialises a Multus NAD in namespace from pool.Spec.CNI.
// No-op when CNI is unset or MultusNetwork is an explicit cross-namespace ref.
// Existing kmc-managed NADs are patched; foreign NADs return an error.
func ensureStaticNADForPool(
	ctx context.Context,
	c client.Client,
	scheme *runtime.Scheme,
	namespace string,
	pool *kmcv1alpha1.IPPool,
) error {
	if pool == nil || pool.Spec.CNI == nil {
		return nil
	}
	ns := strings.TrimSpace(namespace)
	if ns == "" {
		return fmt.Errorf("namespace is required to ensure static NAD")
	}
	if multusCrossNamespace(pool.Spec.MultusNetwork, ns) {
		return nil
	}

	nadName := nadNameFromMultusNetwork(pool.Spec.MultusNetwork)
	if nadName == "" {
		return fmt.Errorf("IPPool %q: multusNetwork is empty", pool.Name)
	}

	config, err := staticPoolCNIConfig(nadName, pool.Spec.CNI)
	if err != nil {
		return fmt.Errorf("IPPool %q: %w", pool.Name, err)
	}

	labels := map[string]string{
		kmcv1alpha1.LabelManagedBy: kmcv1alpha1.ManagedByKMC,
		kmcv1alpha1.LabelResource:  kmcv1alpha1.ResourceNetwork,
		kmcv1alpha1.LabelIPPool:    pool.Name,
	}
	if pool.Spec.CNI.VLAN != nil {
		labels[kmcv1alpha1.LabelVLAN] = strconv.Itoa(int(*pool.Spec.CNI.VLAN))
	}

	existing := newNADUnstructured(ns, nadName)
	err = c.Get(ctx, client.ObjectKey{Namespace: ns, Name: nadName}, existing)
	if apierrors.IsNotFound(err) {
		nad := newNADUnstructured(ns, nadName)
		nad.SetLabels(labels)
		if err := unstructured.SetNestedField(nad.Object, config, "spec", "config"); err != nil {
			return err
		}
		// Cluster-scoped IPPool may own namespaced NADs (GC on pool delete).
		if err := controllerutil.SetControllerReference(pool, nad, scheme); err != nil {
			return err
		}
		if err := c.Create(ctx, nad); err != nil {
			if apierrors.IsAlreadyExists(err) {
				return nil
			}
			return fmt.Errorf("create Multus NAD %s/%s: %w", ns, nadName, err)
		}
		return nil
	}
	if err != nil {
		return err
	}

	// Do not clobber NADs we do not manage.
	existingLabels := existing.GetLabels()
	if existingLabels[kmcv1alpha1.LabelManagedBy] != kmcv1alpha1.ManagedByKMC ||
		existingLabels[kmcv1alpha1.LabelResource] != kmcv1alpha1.ResourceNetwork {
		return fmt.Errorf(
			"Multus NAD %s/%s exists but is not kmc-managed static network (refusing to overwrite)",
			ns, nadName,
		)
	}

	before := existing.DeepCopy()
	existing.SetLabels(labels)
	if err := unstructured.SetNestedField(existing.Object, config, "spec", "config"); err != nil {
		return err
	}
	if err := controllerutil.SetControllerReference(pool, existing, scheme); err != nil {
		return err
	}
	return c.Patch(ctx, existing, client.MergeFrom(before))
}
