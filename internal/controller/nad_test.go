package controller

import (
	"context"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
)

func TestEnsureStaticNADForPool(t *testing.T) {
	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(kmcv1alpha1.AddToScheme(scheme))

	vlan := int32(100)
	pool := &kmcv1alpha1.IPPool{
		ObjectMeta: metav1.ObjectMeta{Name: "public", UID: "pool-uid"},
		Spec: kmcv1alpha1.IPPoolSpec{
			MultusNetwork: "bridge-external",
			CIDR:          "74.82.62.0/27",
			Gateway:       "74.82.62.1",
			CNI: &kmcv1alpha1.IPPoolCNISpec{
				Type:   "bridge",
				Bridge: "br-external",
				VLAN:   &vlan,
			},
		},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pool).Build()

	if err := ensureStaticNADForPool(context.Background(), c, scheme, "tenant-a", pool); err != nil {
		t.Fatal(err)
	}

	nad := newNADUnstructured("tenant-a", "bridge-external")
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "tenant-a", Name: "bridge-external"}, nad); err != nil {
		t.Fatalf("expected NAD: %v", err)
	}
	labels := nad.GetLabels()
	if labels[kmcv1alpha1.LabelResource] != kmcv1alpha1.ResourceNetwork {
		t.Fatalf("resource label = %q", labels[kmcv1alpha1.LabelResource])
	}
	if labels[kmcv1alpha1.LabelIPPool] != "public" {
		t.Fatalf("ip-pool label = %q", labels[kmcv1alpha1.LabelIPPool])
	}
	if labels[kmcv1alpha1.LabelVLAN] != "100" {
		t.Fatalf("vlan label = %q", labels[kmcv1alpha1.LabelVLAN])
	}
	cfg, found, err := unstructured.NestedString(nad.Object, "spec", "config")
	if err != nil || !found {
		t.Fatalf("config: found=%v err=%v", found, err)
	}
	if !strings.Contains(cfg, "br-external") || !strings.Contains(cfg, "bridge-external") {
		t.Fatalf("config = %q", cfg)
	}

	// Idempotent
	if err := ensureStaticNADForPool(context.Background(), c, scheme, "tenant-a", pool); err != nil {
		t.Fatal(err)
	}

	// No-op without cni
	poolNoCNI := pool.DeepCopy()
	poolNoCNI.Spec.CNI = nil
	if err := ensureStaticNADForPool(context.Background(), c, scheme, "other", poolNoCNI); err != nil {
		t.Fatal(err)
	}
	missing := newNADUnstructured("other", "bridge-external")
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "other", Name: "bridge-external"}, missing); err == nil {
		t.Fatal("expected no NAD without cni template")
	}

	// Cross-namespace multus ref: no ensure
	poolX := pool.DeepCopy()
	poolX.Spec.MultusNetwork = "other-ns/bridge-external"
	if err := ensureStaticNADForPool(context.Background(), c, scheme, "tenant-a", poolX); err != nil {
		t.Fatal(err)
	}
}

func TestMultusCrossNamespace(t *testing.T) {
	if multusCrossNamespace("bridge-external", "default") {
		t.Fatal("bare name should not be cross-ns")
	}
	if multusCrossNamespace("default/bridge-external", "default") {
		t.Fatal("same-ns ref should not be cross-ns")
	}
	if !multusCrossNamespace("other/bridge-external", "default") {
		t.Fatal("other-ns ref should be cross-ns")
	}
}
