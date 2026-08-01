package controller

import (
	"encoding/json"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
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
