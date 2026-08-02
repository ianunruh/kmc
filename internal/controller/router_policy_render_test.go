package controller

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/event"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	rt "github.com/ianunruh/kmc/internal/router"
)

// Regression: list-order / nil-slice noise must not bump policy generation.
// Unbounded generation was a live outage mode (agent apply thrash + ConfigMap races).
func TestNextPolicyGeneration_StableAcrossNoise(t *testing.T) {
	base := rt.EmptyPolicyDoc("blue-net-router", "kmc-test")
	base.Metadata.Generation = 100
	base.Interfaces = []rt.PolicyInterface{{
		VPC: "blue-net", CIDR: "10.99.0.0/24", Gateway: "10.99.0.1",
		MAC: "1e:5a:97:c8:3e:e1", Domain: "blue-net.vpc.local", DHCP: rt.DefaultDHCP(),
	}}
	base.External = &rt.PolicyExternal{
		MultusNetwork: "external",
		PrimaryCIDR:   "10.30.0.2/24",
		Gateway:       "10.30.0.1",
		MAC:           "02:8b:63:f4:7f:37",
		SNAT:          true,
	}
	base.Leases = []rt.PolicyLease{
		{VPC: "blue-net", MAC: "aa:aa", IP: "10.99.0.2", Hostname: "blue-1", VM: "blue-1"},
		{VPC: "blue-net", MAC: "bb:bb", IP: "10.99.0.3", Hostname: "blue-2", VM: "blue-2"},
	}
	base.FloatingIPs = []rt.PolicyFloatingIP{
		{ID: "10.30.0.3", Public: "10.30.0.3", Prefix: 24, Private: "10.99.0.2", TargetVM: "blue-1", VPC: "blue-net"},
		{ID: "10.30.0.4", Public: "10.30.0.4", Prefix: 24, VPC: "blue-net"},
	}
	base.PortForwards = []rt.PolicyPortForward{
		{ID: "10.30.0.4-tcp-22", Public: "10.30.0.4", PublicPort: 22, Private: "10.99.0.3", PrivatePort: 22, Protocol: "TCP", TargetVM: "blue-2", VPC: "blue-net"},
	}

	// Reordered projected lists + nil empty slices (as project* can return).
	noisy := base
	noisy.Metadata.Generation = 0 // re-render starts without gen or with prev
	noisy.Leases = []rt.PolicyLease{base.Leases[1], base.Leases[0]}
	noisy.FloatingIPs = []rt.PolicyFloatingIP{base.FloatingIPs[1], base.FloatingIPs[0]}
	// PortForwards order flipped is covered by equality sort; leave single entry.

	got := nextPolicyGeneration(&base, &noisy)
	if got != 100 {
		t.Fatalf("generation bumped on list-order noise: got %d want 100", got)
	}

	// Nil vs empty projected lists.
	nilLists := base
	nilLists.Metadata.Generation = 1
	nilLists.Leases = nil
	nilLists.FloatingIPs = nil
	nilLists.PortForwards = nil
	emptyLists := base
	emptyLists.Metadata.Generation = 50
	emptyLists.Leases = []rt.PolicyLease{}
	emptyLists.FloatingIPs = []rt.PolicyFloatingIP{}
	emptyLists.PortForwards = []rt.PolicyPortForward{}
	// Equal content is empty lists on both sides of the non-interface fields —
	// strip projected content from base first.
	prevEmpty := base
	prevEmpty.Metadata.Generation = 7
	prevEmpty.Leases = []rt.PolicyLease{}
	prevEmpty.FloatingIPs = []rt.PolicyFloatingIP{}
	prevEmpty.PortForwards = []rt.PolicyPortForward{}
	if g := nextPolicyGeneration(&prevEmpty, &nilLists); g != 7 {
		t.Fatalf("nil vs empty lists bumped gen: got %d want 7", g)
	}
	if g := nextPolicyGeneration(&prevEmpty, &emptyLists); g != 7 {
		t.Fatalf("empty vs empty bumped gen: got %d want 7", g)
	}

	// Real content change must bump.
	changed := base
	changed.Metadata.Generation = 0
	changed.Leases = []rt.PolicyLease{
		{VPC: "blue-net", MAC: "aa:aa", IP: "10.99.0.9", Hostname: "blue-1", VM: "blue-1"},
	}
	if g := nextPolicyGeneration(&base, &changed); g != 101 {
		t.Fatalf("real change should bump 100→101, got %d", g)
	}
}

// End-to-end: repeated reconciles with multi lease/FIP/PF must not race generation.
func TestRouterReconcile_PolicyGenerationStableOnRereconcile(t *testing.T) {
	scheme := routerTestScheme(t)
	vpc := &kmcv1alpha1.VPC{
		ObjectMeta: metav1.ObjectMeta{Name: "blue-net", Namespace: "kmc-test"},
		Spec: kmcv1alpha1.VPCSpec{
			VLANPoolRef: corev1.LocalObjectReference{Name: "default"},
			CIDR:        "10.99.0.0/24",
			Gateway:     "10.99.0.1",
		},
	}
	nad := newNADUnstructured("kmc-test", "blue-net")
	nad.SetAnnotations(map[string]string{
		kmcv1alpha1.AnnotationCIDR:    "10.99.0.0/24",
		kmcv1alpha1.AnnotationGateway: "10.99.0.1",
	})

	guest1 := &kmcv1alpha1.IPAddress{
		ObjectMeta: metav1.ObjectMeta{Name: "10-99-0-2", Namespace: "kmc-test"},
		Spec: kmcv1alpha1.IPAddressSpec{
			Address: "10.99.0.2", PrefixLength: 24,
			PoolRef:  kmcv1alpha1.PoolReference{Kind: "VPC", Name: "blue-net"},
			ClaimRef: &corev1.ObjectReference{Kind: "VirtualMachine", Name: "blue-1"},
			Interface: &kmcv1alpha1.InterfaceBinding{
				MAC: "9e:65:ce:12:5b:24", Hostname: "blue-1",
			},
		},
	}
	guest2 := &kmcv1alpha1.IPAddress{
		ObjectMeta: metav1.ObjectMeta{Name: "10-99-0-3", Namespace: "kmc-test"},
		Spec: kmcv1alpha1.IPAddressSpec{
			Address: "10.99.0.3", PrefixLength: 24,
			PoolRef:  kmcv1alpha1.PoolReference{Kind: "VPC", Name: "blue-net"},
			ClaimRef: &corev1.ObjectReference{Kind: "VirtualMachine", Name: "blue-2"},
			Interface: &kmcv1alpha1.InterfaceBinding{
				MAC: "06:a4:24:4c:2d:1a", Hostname: "blue-2",
			},
		},
	}
	fip1 := &kmcv1alpha1.FloatingIP{
		ObjectMeta: metav1.ObjectMeta{Name: "10-30-0-3", Namespace: "kmc-test", UID: "fip-1"},
		Spec: kmcv1alpha1.FloatingIPSpec{
			PoolRef:        kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "vlan3000"},
			Address:        "10.30.0.3",
			VPCRef:         corev1.LocalObjectReference{Name: "blue-net"},
			PrivateAddress: "10.99.0.2",
			TargetVM:       &corev1.LocalObjectReference{Name: "blue-1"},
		},
		Status: kmcv1alpha1.FloatingIPStatus{Address: "10.30.0.3", PrefixLength: 24},
	}
	fip2 := &kmcv1alpha1.FloatingIP{
		ObjectMeta: metav1.ObjectMeta{Name: "10-30-0-4", Namespace: "kmc-test", UID: "fip-2"},
		Spec: kmcv1alpha1.FloatingIPSpec{
			PoolRef: kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "vlan3000"},
			Address: "10.30.0.4",
			VPCRef:  corev1.LocalObjectReference{Name: "blue-net"},
		},
		Status: kmcv1alpha1.FloatingIPStatus{Address: "10.30.0.4", PrefixLength: 24},
	}
	pf := &kmcv1alpha1.PortForward{
		ObjectMeta: metav1.ObjectMeta{Name: "pf-22", Namespace: "kmc-test", UID: "pf-1"},
		Spec: kmcv1alpha1.PortForwardSpec{
			VPCRef:         corev1.LocalObjectReference{Name: "blue-net"},
			Protocol:       "TCP",
			PublicAddress:  "10.30.0.4",
			PublicPort:     22,
			PrivateAddress: "10.99.0.3",
			PrivatePort:    22,
			TargetVM:       &corev1.LocalObjectReference{Name: "blue-2"},
		},
	}

	cores := int32(1)
	router := &kmcv1alpha1.Router{
		ObjectMeta: metav1.ObjectMeta{
			Name: "blue-net-router", Namespace: "kmc-test",
			Generation: 2, UID: "router-uid-stable",
		},
		Spec: kmcv1alpha1.RouterSpec{
			VPCs: []kmcv1alpha1.RouterVPCAttachment{{Name: "blue-net"}},
			Appliance: kmcv1alpha1.RouterApplianceSpec{
				Image: kmcv1alpha1.RouterImageRef{Namespace: "vm-images", Name: "ubuntu"},
				CPUCores: &cores, Memory: "1Gi", DiskSize: "10Gi",
				SSHPublicKeys: []string{"ssh-ed25519 AAAA test"},
			},
		},
	}
	controllerutil.AddFinalizer(router, kmcv1alpha1.RouterFinalizer)

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&kmcv1alpha1.Router{}, &kmcv1alpha1.IPAddress{}, &kmcv1alpha1.FloatingIP{}, &kmcv1alpha1.PortForward{}).
		WithObjects(vpc, nad, guest1, guest2, fip1, fip2, pf, router).
		Build()

	r := &RouterReconciler{Client: c, Scheme: scheme, SkipAppliance: true}
	req := ctrl.Request{NamespacedName: types.NamespacedName{Name: router.Name, Namespace: router.Namespace}}

	var firstGen int64
	for i := 0; i < 8; i++ {
		if _, err := r.Reconcile(context.Background(), req); err != nil {
			t.Fatalf("reconcile %d: %v", i, err)
		}
		var got kmcv1alpha1.Router
		if err := c.Get(context.Background(), client.ObjectKeyFromObject(router), &got); err != nil {
			t.Fatal(err)
		}
		if got.Status.PolicyGeneration < 1 {
			t.Fatalf("reconcile %d: expected policyGeneration >= 1, got %d", i, got.Status.PolicyGeneration)
		}
		if i == 0 {
			firstGen = got.Status.PolicyGeneration
			continue
		}
		if got.Status.PolicyGeneration != firstGen {
			t.Fatalf("policy generation thrashed: reconcile 0 → %d, reconcile %d → %d",
				firstGen, i, got.Status.PolicyGeneration)
		}
	}

	// Policy body must include both leases / FIPs / PF and stay at firstGen in metadata.
	var cm corev1.ConfigMap
	if err := c.Get(context.Background(), client.ObjectKey{
		Namespace: "kmc-test", Name: rt.ConfigMapName("blue-net-router"),
	}, &cm); err != nil {
		t.Fatal(err)
	}
	doc, err := rt.ParsePolicyDoc(cm.Data[kmcv1alpha1.RouterPolicyDataKey])
	if err != nil || doc == nil {
		t.Fatalf("parse: %v", err)
	}
	if doc.Metadata.Generation != firstGen {
		t.Fatalf("policy.json generation %d != status %d", doc.Metadata.Generation, firstGen)
	}
	if len(doc.Leases) != 2 || len(doc.FloatingIPs) != 2 || len(doc.PortForwards) != 1 {
		t.Fatalf("expected 2 leases, 2 fips, 1 pf; got leases=%d fips=%d pfs=%d",
			len(doc.Leases), len(doc.FloatingIPs), len(doc.PortForwards))
	}
	// Leases sorted by IP.
	if doc.Leases[0].IP != "10.99.0.2" || doc.Leases[1].IP != "10.99.0.3" {
		t.Fatalf("leases not sorted by IP: %+v", doc.Leases)
	}
	// FIPs sorted by public.
	if doc.FloatingIPs[0].Public != "10.30.0.3" || doc.FloatingIPs[1].Public != "10.30.0.4" {
		t.Fatalf("floatingIPs not sorted by public: %+v", doc.FloatingIPs)
	}

	// Simulate agent heartbeat (annotation-only) then re-reconcile — generation must hold.
	cm.Annotations = map[string]string{
		kmcv1alpha1.AnnotationAgentStatus:      "Ready",
		kmcv1alpha1.AnnotationAgentHeartbeatAt: "2026-08-02T18:00:00Z",
		kmcv1alpha1.AnnotationAgentVersion:     "deadbeef",
	}
	if err := c.Update(context.Background(), &cm); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	var after kmcv1alpha1.Router
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(router), &after); err != nil {
		t.Fatal(err)
	}
	if after.Status.PolicyGeneration != firstGen {
		t.Fatalf("generation moved after agent-style annotation update: %d → %d",
			firstGen, after.Status.PolicyGeneration)
	}
}

// Stored policy with unsorted projected lists must not look like a change.
func TestNextPolicyGeneration_UnsortedStoredPolicy(t *testing.T) {
	sorted := rt.EmptyPolicyDoc("r", "ns")
	sorted.Metadata.Generation = 50
	sorted.Leases = []rt.PolicyLease{
		{VPC: "v", MAC: "a", IP: "10.0.0.2", Hostname: "a"},
		{VPC: "v", MAC: "b", IP: "10.0.0.3", Hostname: "b"},
	}
	unsorted := sorted
	unsorted.Metadata.Generation = 50
	unsorted.Leases = []rt.PolicyLease{sorted.Leases[1], sorted.Leases[0]}

	// Controller re-renders sorted; prev is unsorted store — must keep gen.
	if g := nextPolicyGeneration(&unsorted, &sorted); g != 50 {
		t.Fatalf("unsorted store vs sorted render bumped gen: got %d", g)
	}
}

func TestConfigMapDataChangedPredicate_IgnoresAnnotationOnly(t *testing.T) {
	pred := configMapDataChangedPredicate()
	oldCM := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name: "kmc-router-x", Namespace: "ns",
			Labels: map[string]string{"app": "kmc"},
			Annotations: map[string]string{
				kmcv1alpha1.AnnotationAgentHeartbeatAt: "t1",
			},
		},
		Data: map[string]string{"policy.json": `{"generation":1}`},
	}
	newCM := oldCM.DeepCopy()
	newCM.Annotations[kmcv1alpha1.AnnotationAgentHeartbeatAt] = "t2"
	newCM.Annotations[kmcv1alpha1.AnnotationAgentStatus] = "Ready"

	if pred.Update(event.UpdateEvent{ObjectOld: oldCM, ObjectNew: newCM}) {
		t.Fatal("annotation-only update should be ignored")
	}

	newCM2 := oldCM.DeepCopy()
	newCM2.Data["policy.json"] = `{"generation":2}`
	if !pred.Update(event.UpdateEvent{ObjectOld: oldCM, ObjectNew: newCM2}) {
		t.Fatal("policy.json data change should requeue")
	}
}
