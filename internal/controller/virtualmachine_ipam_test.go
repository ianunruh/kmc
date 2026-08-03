package controller

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
)

func vmIPAMScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(s))
	utilruntime.Must(kmcv1alpha1.AddToScheme(s))
	return s
}

func testVM(ns, name string, multusNetwork, mac string) *unstructured.Unstructured {
	vm := newVMUnstructured(ns, name)
	vm.SetUID("vm-uid-1")
	vm.SetAnnotations(map[string]string{})
	_ = unstructured.SetNestedSlice(vm.Object, []interface{}{
		map[string]interface{}{
			"name": "net1",
			"multus": map[string]interface{}{
				"networkName": multusNetwork,
			},
		},
	}, "spec", "template", "spec", "networks")
	iface := map[string]interface{}{
		"name":   "net1",
		"bridge": map[string]interface{}{},
	}
	if mac != "" {
		iface["macAddress"] = mac
	}
	_ = unstructured.SetNestedSlice(vm.Object, []interface{}{iface},
		"spec", "template", "spec", "domain", "devices", "interfaces")
	return vm
}

func TestVirtualMachineIPAM_BackfillClaim(t *testing.T) {
	scheme := vmIPAMScheme(t)
	pool := &kmcv1alpha1.IPPool{
		ObjectMeta: metav1.ObjectMeta{Name: "public", UID: "pool-1"},
		Spec: kmcv1alpha1.IPPoolSpec{
			MultusNetwork: "bridge-external",
			CIDR:          "10.50.0.0/24",
			Gateway:       "10.50.0.1",
		},
	}
	vm := testVM("default", "web", "bridge-external", "02:aa:bb:cc:dd:ee")

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(pool, vm).
		Build()

	r := &VirtualMachineIPAMReconciler{
		Client:   c,
		Scheme:   scheme,
		Recorder: record.NewFakeRecorder(10),
	}

	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Namespace: "default", Name: "web"},
	}); err != nil {
		t.Fatal(err)
	}

	var list kmcv1alpha1.IPAddressList
	if err := c.List(context.Background(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("claims = %d, want 1", len(list.Items))
	}
	ip := list.Items[0]
	if ip.Spec.Address != "10.50.0.2" {
		t.Fatalf("address = %q (gateway excluded)", ip.Spec.Address)
	}
	if ip.Spec.ClaimRef == nil || ip.Spec.ClaimRef.Name != "web" {
		t.Fatalf("claimRef = %+v", ip.Spec.ClaimRef)
	}
	if ip.Spec.Interface == nil || ip.Spec.Interface.MAC != "02:aa:bb:cc:dd:ee" {
		t.Fatalf("interface = %+v", ip.Spec.Interface)
	}
	if len(ip.GetOwnerReferences()) == 0 {
		t.Fatal("expected ownerRef for GC")
	}

	got := newVMUnstructured("default", "web")
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "default", Name: "web"}, got); err != nil {
		t.Fatal(err)
	}
	if got.GetAnnotations()[annotationGuestIPv4] == "" {
		t.Fatalf("expected ipv4 annotation, got %#v", got.GetAnnotations())
	}
}

func TestVirtualMachineIPAM_AdoptExisting(t *testing.T) {
	scheme := vmIPAMScheme(t)
	vpc := &kmcv1alpha1.VPC{
		ObjectMeta: metav1.ObjectMeta{Name: "app-net", Namespace: "default"},
		Spec: kmcv1alpha1.VPCSpec{
			VLANPoolRef: corev1.LocalObjectReference{Name: "default"},
			CIDR:        "10.40.1.0/24",
			Gateway:     "10.40.1.1",
		},
	}
	vm := testVM("default", "web", "app-net", "02:11:22:33:44:55")
	claim := &kmcv1alpha1.IPAddress{
		ObjectMeta: metav1.ObjectMeta{Name: "10-40-1-20", Namespace: "default"},
		Spec: kmcv1alpha1.IPAddressSpec{
			Address:      "10.40.1.20",
			PrefixLength: 24,
			PoolRef:      kmcv1alpha1.PoolReference{Kind: "VPC", Name: "app-net"},
			ClaimRef: &corev1.ObjectReference{
				APIVersion: "kubevirt.io/v1",
				Kind:       "VirtualMachine",
				Namespace:  "default",
				Name:       "web",
			},
		},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(vpc, vm, claim).Build()
	r := &VirtualMachineIPAMReconciler{Client: c, Scheme: scheme}

	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Namespace: "default", Name: "web"},
	}); err != nil {
		t.Fatal(err)
	}

	var got kmcv1alpha1.IPAddress
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "default", Name: "10-40-1-20"}, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.GetOwnerReferences()) == 0 {
		t.Fatal("expected adopt ownerRef")
	}
	if got.Spec.Interface == nil || got.Spec.Interface.MAC != "02:11:22:33:44:55" {
		t.Fatalf("expected MAC enrich, got %+v", got.Spec.Interface)
	}
	var list kmcv1alpha1.IPAddressList
	_ = c.List(context.Background(), &list)
	if len(list.Items) != 1 {
		t.Fatalf("claims = %d", len(list.Items))
	}
}

func TestVirtualMachineIPAM_SkipRouter(t *testing.T) {
	scheme := vmIPAMScheme(t)
	pool := &kmcv1alpha1.IPPool{
		ObjectMeta: metav1.ObjectMeta{Name: "public"},
		Spec: kmcv1alpha1.IPPoolSpec{
			MultusNetwork: "bridge-external",
			CIDR:          "10.50.0.0/24",
			Gateway:       "10.50.0.1",
		},
	}
	vm := testVM("default", "shared", "bridge-external", "02:aa:bb:cc:dd:ee")
	vm.SetLabels(map[string]string{kmcv1alpha1.LabelRole: kmcv1alpha1.RoleRouter})

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pool, vm).Build()
	r := &VirtualMachineIPAMReconciler{Client: c, Scheme: scheme}

	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Namespace: "default", Name: "shared"},
	}); err != nil {
		t.Fatal(err)
	}
	var list kmcv1alpha1.IPAddressList
	_ = c.List(context.Background(), &list)
	if len(list.Items) != 0 {
		t.Fatalf("router VM should skip IPAM, got %d claims", len(list.Items))
	}
}
