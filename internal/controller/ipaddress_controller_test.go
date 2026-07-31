package controller

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
)

func testScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	if err := kmcv1alpha1.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	return s
}

func newIPAddress(name string, mutate ...func(*kmcv1alpha1.IPAddress)) *kmcv1alpha1.IPAddress {
	obj := &kmcv1alpha1.IPAddress{
		ObjectMeta: metav1.ObjectMeta{
			Name:       name,
			Namespace:  "default",
			Generation: 1,
		},
		Spec: kmcv1alpha1.IPAddressSpec{
			Address:      "10.40.1.20",
			PrefixLength: 24,
			PoolRef: kmcv1alpha1.PoolReference{
				Kind: "VPC",
				Name: "app-net",
			},
		},
	}
	for _, fn := range mutate {
		fn(obj)
	}
	return obj
}

func TestIPAddressReconcile_BindsValidSpec(t *testing.T) {
	scheme := testScheme(t)
	obj := newIPAddress("10-40-1-20")
	// Pre-seed finalizer so the first reconcile performs the status update.
	controllerutil.AddFinalizer(obj, kmcv1alpha1.IPAddressFinalizer)

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&kmcv1alpha1.IPAddress{}).
		WithObjects(obj).
		Build()

	r := &IPAddressReconciler{
		Client:   c,
		Scheme:   scheme,
		Recorder: record.NewFakeRecorder(10),
	}

	_, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: obj.Name, Namespace: obj.Namespace},
	})
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	var got kmcv1alpha1.IPAddress
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(obj), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status.Phase != kmcv1alpha1.IPAddressPhaseBound {
		t.Fatalf("phase = %q, want Bound", got.Status.Phase)
	}
	if !controllerutil.ContainsFinalizer(&got, kmcv1alpha1.IPAddressFinalizer) {
		t.Fatal("expected finalizer")
	}
	if got.Status.ObservedGeneration != 1 {
		t.Fatalf("observedGeneration = %d", got.Status.ObservedGeneration)
	}
	ready := false
	for _, cond := range got.Status.Conditions {
		if cond.Type == kmcv1alpha1.IPAddressConditionReady && cond.Status == metav1.ConditionTrue {
			ready = true
		}
	}
	if !ready {
		t.Fatalf("Ready condition not True: %+v", got.Status.Conditions)
	}
}

func TestIPAddressReconcile_AddsFinalizer(t *testing.T) {
	scheme := testScheme(t)
	obj := newIPAddress("10-40-1-21")

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&kmcv1alpha1.IPAddress{}).
		WithObjects(obj).
		Build()

	r := &IPAddressReconciler{Client: c, Scheme: scheme, Recorder: record.NewFakeRecorder(10)}

	res, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: obj.Name, Namespace: obj.Namespace},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Requeue {
		t.Fatal("expected requeue after adding finalizer")
	}

	var got kmcv1alpha1.IPAddress
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(obj), &got); err != nil {
		t.Fatal(err)
	}
	if !controllerutil.ContainsFinalizer(&got, kmcv1alpha1.IPAddressFinalizer) {
		t.Fatal("expected finalizer after first reconcile")
	}
}

func TestIPAddressReconcile_InvalidSpec(t *testing.T) {
	scheme := testScheme(t)
	obj := newIPAddress("bad", func(o *kmcv1alpha1.IPAddress) {
		o.Spec.Address = "not-an-ip"
		controllerutil.AddFinalizer(o, kmcv1alpha1.IPAddressFinalizer)
	})

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&kmcv1alpha1.IPAddress{}).
		WithObjects(obj).
		Build()

	r := &IPAddressReconciler{Client: c, Scheme: scheme, Recorder: record.NewFakeRecorder(10)}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: obj.Name, Namespace: obj.Namespace},
	}); err != nil {
		t.Fatal(err)
	}

	var got kmcv1alpha1.IPAddress
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(obj), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status.Phase != kmcv1alpha1.IPAddressPhasePending {
		t.Fatalf("phase = %q, want Pending", got.Status.Phase)
	}
}

func TestIPAddressReconcile_RemovesFinalizerOnDelete(t *testing.T) {
	scheme := testScheme(t)
	now := metav1.Now()
	obj := newIPAddress("10-40-1-22", func(o *kmcv1alpha1.IPAddress) {
		controllerutil.AddFinalizer(o, kmcv1alpha1.IPAddressFinalizer)
		o.DeletionTimestamp = &now
		// fake client requires finalizers when DeletionTimestamp is set
		o.Finalizers = []string{kmcv1alpha1.IPAddressFinalizer}
	})

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&kmcv1alpha1.IPAddress{}).
		WithObjects(obj).
		Build()

	r := &IPAddressReconciler{Client: c, Scheme: scheme, Recorder: record.NewFakeRecorder(10)}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: obj.Name, Namespace: obj.Namespace},
	}); err != nil {
		t.Fatal(err)
	}

	var got kmcv1alpha1.IPAddress
	err := c.Get(context.Background(), client.ObjectKeyFromObject(obj), &got)
	// Object may be fully deleted once finalizers are gone.
	if err == nil && controllerutil.ContainsFinalizer(&got, kmcv1alpha1.IPAddressFinalizer) {
		t.Fatal("finalizer should be removed")
	}
}
