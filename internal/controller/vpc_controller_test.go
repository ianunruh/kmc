package controller

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
)

func TestVPCReconcile_AllocatesVLAN(t *testing.T) {
	scheme := testScheme(t)
	pool := &kmcv1alpha1.VLANPool{
		ObjectMeta: metav1.ObjectMeta{Name: "default", Generation: 1},
		Spec: kmcv1alpha1.VLANPoolSpec{
			Start:  3000,
			End:    3002,
			Bridge: "br0",
			Exclude: []int32{3000},
		},
	}
	vpc := &kmcv1alpha1.VPC{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "app-net",
			Namespace:  "default",
			Generation: 1,
		},
		Spec: kmcv1alpha1.VPCSpec{
			VLANPoolRef: corev1.LocalObjectReference{Name: "default"},
			CIDR:        "10.40.1.0/24",
			Gateway:     "10.40.1.1",
		},
	}
	controllerutil.AddFinalizer(vpc, kmcv1alpha1.VPCFinalizer)

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&kmcv1alpha1.VPC{}, &kmcv1alpha1.VLANPool{}).
		WithObjects(pool, vpc).
		Build()

	r := &VPCReconciler{Client: c, Scheme: scheme, Recorder: record.NewFakeRecorder(10)}

	// First reconcile: allocate VLAN (NAD create may fail without Multus CRD in fake —
	// fake client accepts unstructured creates).
	_, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: vpc.Name, Namespace: vpc.Namespace},
	})
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	var got kmcv1alpha1.VPC
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(vpc), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status.VLAN != 3001 {
		t.Fatalf("vlan = %d, want 3001 (3000 excluded)", got.Status.VLAN)
	}
	if got.Status.Bridge != "br0" {
		t.Fatalf("bridge = %q", got.Status.Bridge)
	}
}

func TestValidateVPCSpec(t *testing.T) {
	obj := &kmcv1alpha1.VPC{
		Spec: kmcv1alpha1.VPCSpec{
			VLANPoolRef: corev1.LocalObjectReference{Name: "default"},
			Gateway:     "10.0.0.1",
		},
	}
	if err := validateVPCSpec(obj); err == nil {
		t.Fatal("expected gateway-without-cidr error")
	}
	obj.Spec.CIDR = "10.40.1.0/24"
	obj.Spec.Gateway = "10.40.1.1"
	if err := validateVPCSpec(obj); err != nil {
		t.Fatal(err)
	}
}

func TestValidateFloatingIPAndPortForward(t *testing.T) {
	fip := &kmcv1alpha1.FloatingIP{
		Spec: kmcv1alpha1.FloatingIPSpec{
			PoolRef: kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "public"},
			VPCRef:  corev1.LocalObjectReference{Name: "app-net"},
			Address: "74.82.62.10",
		},
	}
	if err := validateFloatingIPSpec(fip); err != nil {
		t.Fatal(err)
	}

	pf := &kmcv1alpha1.PortForward{
		Spec: kmcv1alpha1.PortForwardSpec{
			VPCRef:         corev1.LocalObjectReference{Name: "app-net"},
			PublicAddress:  "74.82.62.2",
			PublicPort:     443,
			PrivateAddress: "10.40.1.20",
			PrivatePort:    443,
			Protocol:       "TCP",
		},
	}
	if err := validatePortForwardSpec(pf); err != nil {
		t.Fatal(err)
	}
}
