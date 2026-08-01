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

func TestFloatingIPReconcile_ClaimsPreferredAddress(t *testing.T) {
	scheme := testScheme(t)
	pool := &kmcv1alpha1.IPPool{
		ObjectMeta: metav1.ObjectMeta{Name: "public"},
		Spec: kmcv1alpha1.IPPoolSpec{
			MultusNetwork: "bridge-external",
			CIDR:          "74.82.62.0/27",
			Gateway:       "74.82.62.1",
		},
	}
	fip := &kmcv1alpha1.FloatingIP{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "74-82-62-10",
			Namespace:  "default",
			Generation: 1,
			UID:        "fip-uid-1",
		},
		Spec: kmcv1alpha1.FloatingIPSpec{
			PoolRef: kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "public"},
			Address: "74.82.62.10",
			VPCRef:  corev1.LocalObjectReference{Name: "app-net"},
		},
	}
	controllerutil.AddFinalizer(fip, kmcv1alpha1.FloatingIPFinalizer)

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&kmcv1alpha1.FloatingIP{}, &kmcv1alpha1.IPAddress{}).
		WithObjects(pool, fip).
		Build()

	r := &FloatingIPReconciler{Client: c, Scheme: scheme, Recorder: record.NewFakeRecorder(10)}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: fip.Name, Namespace: fip.Namespace},
	}); err != nil {
		t.Fatal(err)
	}

	var got kmcv1alpha1.FloatingIP
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(fip), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status.Address != "74.82.62.10" {
		t.Fatalf("status.address = %q", got.Status.Address)
	}
	if got.Status.PrefixLength != 27 {
		t.Fatalf("prefix = %d", got.Status.PrefixLength)
	}
	if got.Status.Phase != kmcv1alpha1.FloatingIPPhaseHeld {
		t.Fatalf("phase = %q", got.Status.Phase)
	}

	var ip kmcv1alpha1.IPAddress
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "default", Name: "74-82-62-10"}, &ip); err != nil {
		t.Fatalf("expected IPAddress claim: %v", err)
	}
	if ip.Spec.ClaimRef == nil || ip.Spec.ClaimRef.Kind != "FloatingIP" {
		t.Fatalf("claimRef = %+v", ip.Spec.ClaimRef)
	}
}

func TestFloatingIPReconcile_AutoAllocate(t *testing.T) {
	scheme := testScheme(t)
	pool := &kmcv1alpha1.IPPool{
		ObjectMeta: metav1.ObjectMeta{Name: "public"},
		Spec: kmcv1alpha1.IPPoolSpec{
			MultusNetwork: "bridge-external",
			CIDR:          "10.0.0.0/30",
			Gateway:       "10.0.0.1",
		},
	}
	// /30 usable: .1 (gw excluded) and .2
	fip := &kmcv1alpha1.FloatingIP{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "auto-fip",
			Namespace:  "default",
			Generation: 1,
			UID:        "fip-uid-2",
		},
		Spec: kmcv1alpha1.FloatingIPSpec{
			PoolRef: kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "public"},
			VPCRef:  corev1.LocalObjectReference{Name: "app-net"},
		},
	}
	controllerutil.AddFinalizer(fip, kmcv1alpha1.FloatingIPFinalizer)

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&kmcv1alpha1.FloatingIP{}, &kmcv1alpha1.IPAddress{}).
		WithObjects(pool, fip).
		Build()

	r := &FloatingIPReconciler{Client: c, Scheme: scheme, Recorder: record.NewFakeRecorder(10)}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: fip.Name, Namespace: fip.Namespace},
	}); err != nil {
		t.Fatal(err)
	}

	var got kmcv1alpha1.FloatingIP
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(fip), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status.Address != "10.0.0.2" {
		t.Fatalf("auto address = %q, want 10.0.0.2", got.Status.Address)
	}
}

func TestFloatingIPReconcile_DeleteReleasesClaim(t *testing.T) {
	scheme := testScheme(t)
	pool := &kmcv1alpha1.IPPool{
		ObjectMeta: metav1.ObjectMeta{Name: "public"},
		Spec: kmcv1alpha1.IPPoolSpec{
			MultusNetwork: "bridge-external",
			CIDR:          "74.82.62.0/27",
		},
	}
	now := metav1.Now()
	fip := &kmcv1alpha1.FloatingIP{
		ObjectMeta: metav1.ObjectMeta{
			Name:              "74-82-62-11",
			Namespace:         "default",
			UID:               "fip-uid-3",
			DeletionTimestamp: &now,
			Finalizers:        []string{kmcv1alpha1.FloatingIPFinalizer},
		},
		Spec: kmcv1alpha1.FloatingIPSpec{
			PoolRef: kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "public"},
			Address: "74.82.62.11",
			VPCRef:  corev1.LocalObjectReference{Name: "app-net"},
		},
		Status: kmcv1alpha1.FloatingIPStatus{Address: "74.82.62.11", PrefixLength: 27},
	}
	ip := &kmcv1alpha1.IPAddress{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "74-82-62-11",
			Namespace: "default",
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: kmcv1alpha1.GroupVersion.String(),
				Kind:       "FloatingIP",
				Name:       fip.Name,
				UID:        fip.UID,
			}},
		},
		Spec: kmcv1alpha1.IPAddressSpec{
			Address:      "74.82.62.11",
			PrefixLength: 27,
			PoolRef:      kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "public"},
			ClaimRef: &corev1.ObjectReference{
				Kind: "FloatingIP",
				Name: fip.Name,
			},
		},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&kmcv1alpha1.FloatingIP{}, &kmcv1alpha1.IPAddress{}).
		WithObjects(pool, fip, ip).
		Build()

	r := &FloatingIPReconciler{Client: c, Scheme: scheme, Recorder: record.NewFakeRecorder(10)}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: fip.Name, Namespace: fip.Namespace},
	}); err != nil {
		t.Fatal(err)
	}

	var remaining kmcv1alpha1.IPAddress
	err := c.Get(context.Background(), client.ObjectKey{Namespace: "default", Name: "74-82-62-11"}, &remaining)
	if err == nil {
		t.Fatal("expected IPAddress to be deleted")
	}
}
