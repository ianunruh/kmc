package controller

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	"github.com/ianunruh/kmc/internal/ipam"
)

func claimTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(s))
	utilruntime.Must(kmcv1alpha1.AddToScheme(s))
	return s
}

func TestAllocateIPAddressFromWindow_FirstFree(t *testing.T) {
	scheme := claimTestScheme(t)
	existing := &kmcv1alpha1.IPAddress{
		ObjectMeta: metav1.ObjectMeta{Name: "10-40-1-2", Namespace: "default"},
		Spec: kmcv1alpha1.IPAddressSpec{
			Address:      "10.40.1.2",
			PrefixLength: 24,
			PoolRef:      kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "public"},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(existing).Build()

	window, err := ipam.ParsePoolWindow("10.40.1.0/24", "10.40.1.1", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	used, err := listUsedAddressesByPool(context.Background(), c, "IPPool", "public")
	if err != nil {
		t.Fatal(err)
	}

	owner := &kmcv1alpha1.FloatingIP{
		ObjectMeta: metav1.ObjectMeta{Name: "fip-1", Namespace: "default", UID: "fip-uid"},
		Spec: kmcv1alpha1.FloatingIPSpec{
			PoolRef: kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "public"},
			VPCRef:  corev1.LocalObjectReference{Name: "app-net"},
		},
	}

	addr, prefix, err := allocateIPAddressFromWindow(
		context.Background(),
		c,
		"default",
		window,
		"IPPool",
		"public",
		"",
		used,
		func(ip *kmcv1alpha1.IPAddress) bool {
			return ip.Spec.ClaimRef != nil && ip.Spec.ClaimRef.Name == owner.Name
		},
		func(ctx context.Context, address string, pfx int32) error {
			ip := &kmcv1alpha1.IPAddress{
				ObjectMeta: metav1.ObjectMeta{
					Name:      ipam.AddressObjectName(address),
					Namespace: "default",
				},
				Spec: kmcv1alpha1.IPAddressSpec{
					Address:      address,
					PrefixLength: pfx,
					PoolRef:      kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "public"},
					ClaimRef: &corev1.ObjectReference{
						Kind: "FloatingIP",
						Name: owner.Name,
					},
				},
			}
			if err := controllerutil.SetControllerReference(owner, ip, scheme); err != nil {
				return err
			}
			return c.Create(ctx, ip)
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if addr != "10.40.1.3" {
		t.Fatalf("address = %q, want 10.40.1.3", addr)
	}
	if prefix != 24 {
		t.Fatalf("prefix = %d", prefix)
	}

	var got kmcv1alpha1.IPAddress
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "default", Name: "10-40-1-3"}, &got); err != nil {
		t.Fatal(err)
	}
}

func TestAllocateIPAddressFromWindow_Preferred(t *testing.T) {
	scheme := claimTestScheme(t)
	c := fake.NewClientBuilder().WithScheme(scheme).Build()
	window, err := ipam.ParsePoolWindow("10.40.1.0/24", "10.40.1.1", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}

	addr, _, err := allocateIPAddressFromWindow(
		context.Background(),
		c,
		"default",
		window,
		"IPPool",
		"public",
		"10.40.1.50",
		map[string]struct{}{},
		nil,
		func(ctx context.Context, address string, pfx int32) error {
			return c.Create(ctx, &kmcv1alpha1.IPAddress{
				ObjectMeta: metav1.ObjectMeta{
					Name:      ipam.AddressObjectName(address),
					Namespace: "default",
				},
				Spec: kmcv1alpha1.IPAddressSpec{
					Address:      address,
					PrefixLength: pfx,
					PoolRef:      kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "public"},
				},
			})
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if addr != "10.40.1.50" {
		t.Fatalf("address = %q", addr)
	}
}

func TestListUsedAddressesByPool(t *testing.T) {
	scheme := claimTestScheme(t)
	items := []client.Object{
		&kmcv1alpha1.IPAddress{
			ObjectMeta: metav1.ObjectMeta{Name: "10-1-0-5", Namespace: "a"},
			Spec: kmcv1alpha1.IPAddressSpec{
				Address: "10.1.0.5", PrefixLength: 24,
				PoolRef: kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "public"},
			},
		},
		&kmcv1alpha1.IPAddress{
			ObjectMeta: metav1.ObjectMeta{Name: "10-2-0-5", Namespace: "b"},
			Spec: kmcv1alpha1.IPAddressSpec{
				Address: "10.2.0.5", PrefixLength: 24,
				PoolRef: kmcv1alpha1.PoolReference{Kind: "VPC", Name: "app-net"},
			},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(items...).Build()
	used, err := listUsedAddressesByPool(context.Background(), c, "IPPool", "public")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := used["10.1.0.5"]; !ok {
		t.Fatal("expected 10.1.0.5")
	}
	if _, ok := used["10.2.0.5"]; ok {
		t.Fatal("VPC claim should not appear in IPPool used set")
	}
}
