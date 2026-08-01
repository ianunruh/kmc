package controller

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	kmcv1alpha1 "github.com/ianunruh/kmc/api/v1alpha1"
	rt "github.com/ianunruh/kmc/internal/router"
)

func routerTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(s))
	utilruntime.Must(kmcv1alpha1.AddToScheme(s))
	return s
}

func TestValidateRouterSpec(t *testing.T) {
	cores := int32(2)
	base := &kmcv1alpha1.Router{
		ObjectMeta: metav1.ObjectMeta{Name: "shared", Namespace: "default"},
		Spec: kmcv1alpha1.RouterSpec{
			VPCs: []kmcv1alpha1.RouterVPCAttachment{{Name: "app-net"}},
			Appliance: kmcv1alpha1.RouterApplianceSpec{
				Image:         kmcv1alpha1.RouterImageRef{Namespace: "vm-images", Name: "ubuntu"},
				CPUCores:      &cores,
				Memory:        "2Gi",
				DiskSize:      "20Gi",
				SSHPublicKeys: []string{"ssh-ed25519 AAAA test"},
			},
		},
	}
	if err := validateRouterSpec(base); err != nil {
		t.Fatal(err)
	}
	bad := base.DeepCopy()
	bad.Spec.VPCs = nil
	if err := validateRouterSpec(bad); err == nil {
		t.Fatal("expected error for empty vpcs")
	}
}

func TestRouterReconcile_ControlPlaneAndGateway(t *testing.T) {
	scheme := routerTestScheme(t)
	vpc := &kmcv1alpha1.VPC{
		ObjectMeta: metav1.ObjectMeta{Name: "app-net", Namespace: "default"},
		Spec: kmcv1alpha1.VPCSpec{
			VLANPoolRef: corev1.LocalObjectReference{Name: "default"},
			CIDR:        "10.40.1.0/24",
			Gateway:     "10.40.1.1",
		},
		Status: kmcv1alpha1.VPCStatus{VLAN: 100, Phase: kmcv1alpha1.VPCPhaseReady},
	}
	// Multus NAD with CIDR annotation
	nad := newNADUnstructured("default", "app-net")
	nad.SetAnnotations(map[string]string{
		kmcv1alpha1.AnnotationCIDR:    "10.40.1.0/24",
		kmcv1alpha1.AnnotationGateway: "10.40.1.1",
	})

	cores := int32(2)
	router := &kmcv1alpha1.Router{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "shared",
			Namespace:  "default",
			Generation: 1,
			UID:        "router-uid-1",
		},
		Spec: kmcv1alpha1.RouterSpec{
			VPCs: []kmcv1alpha1.RouterVPCAttachment{{Name: "app-net"}},
			Appliance: kmcv1alpha1.RouterApplianceSpec{
				Image:         kmcv1alpha1.RouterImageRef{Namespace: "vm-images", Name: "ubuntu"},
				CPUCores:      &cores,
				Memory:        "2Gi",
				DiskSize:      "20Gi",
				SSHPublicKeys: []string{"ssh-ed25519 AAAA test"},
			},
		},
	}
	controllerutil.AddFinalizer(router, kmcv1alpha1.RouterFinalizer)

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&kmcv1alpha1.Router{}, &kmcv1alpha1.IPAddress{}, &kmcv1alpha1.VPC{}).
		WithObjects(vpc, nad, router).
		Build()

	r := &RouterReconciler{
		Client:        c,
		Scheme:        scheme,
		Recorder:      record.NewFakeRecorder(20),
		SkipAppliance: true,
	}

	// Finalizer already present; first reconcile does work.
	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: router.Name, Namespace: router.Namespace},
	}); err != nil {
		t.Fatal(err)
	}

	var got kmcv1alpha1.Router
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(router), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status.PolicyConfigMap != rt.ConfigMapName("shared") {
		t.Fatalf("policyConfigMap = %q", got.Status.PolicyConfigMap)
	}
	if len(got.Status.Interfaces) != 1 || got.Status.Interfaces[0].Gateway != "10.40.1.1" {
		t.Fatalf("interfaces = %+v", got.Status.Interfaces)
	}
	if got.Status.Interfaces[0].MAC == "" {
		t.Fatal("expected MAC assigned")
	}

	// Policy ConfigMap
	var cm corev1.ConfigMap
	if err := c.Get(context.Background(), client.ObjectKey{
		Namespace: "default", Name: rt.ConfigMapName("shared"),
	}, &cm); err != nil {
		t.Fatalf("expected policy ConfigMap: %v", err)
	}
	if cm.Data[kmcv1alpha1.RouterPolicyDataKey] == "" {
		t.Fatal("missing policy.json")
	}
	if cm.Data[kmcv1alpha1.RouterAgentScriptKey] == "" {
		t.Fatal("missing agent.py")
	}
	doc, err := rt.ParsePolicyDoc(cm.Data[kmcv1alpha1.RouterPolicyDataKey])
	if err != nil || doc == nil {
		t.Fatalf("parse policy: %v", err)
	}
	if len(doc.Interfaces) != 1 || doc.Interfaces[0].VPC != "app-net" {
		t.Fatalf("policy interfaces = %+v", doc.Interfaces)
	}

	// Gateway IPAddress claim
	var ip kmcv1alpha1.IPAddress
	if err := c.Get(context.Background(), client.ObjectKey{
		Namespace: "default", Name: "10-40-1-1",
	}, &ip); err != nil {
		t.Fatalf("expected gateway IPAddress: %v", err)
	}
	if ip.Spec.ClaimRef == nil || ip.Spec.ClaimRef.Kind != "Router" {
		t.Fatalf("claimRef = %+v", ip.Spec.ClaimRef)
	}

	// SA + Role
	var sa corev1.ServiceAccount
	if err := c.Get(context.Background(), client.ObjectKey{
		Namespace: "default", Name: rt.ServiceAccountName("shared"),
	}, &sa); err != nil {
		t.Fatalf("expected SA: %v", err)
	}
	var role rbacv1.Role
	if err := c.Get(context.Background(), client.ObjectKey{
		Namespace: "default", Name: rt.RoleName("shared"),
	}, &role); err != nil {
		t.Fatalf("expected Role: %v", err)
	}

	// NAD stamped
	gotNAD := newNADUnstructured("default", "app-net")
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "default", Name: "app-net"}, gotNAD); err != nil {
		t.Fatal(err)
	}
	if gotNAD.GetAnnotations()[kmcv1alpha1.AnnotationRouter] != "shared" {
		t.Fatalf("router ann = %q", gotNAD.GetAnnotations()[kmcv1alpha1.AnnotationRouter])
	}
}

func TestRouterReconcile_ProjectsFloatingIPAndLease(t *testing.T) {
	scheme := routerTestScheme(t)
	vpc := &kmcv1alpha1.VPC{
		ObjectMeta: metav1.ObjectMeta{Name: "app-net", Namespace: "default"},
		Spec: kmcv1alpha1.VPCSpec{
			VLANPoolRef: corev1.LocalObjectReference{Name: "default"},
			CIDR:        "10.40.1.0/24",
			Gateway:     "10.40.1.1",
		},
	}
	nad := newNADUnstructured("default", "app-net")
	nad.SetAnnotations(map[string]string{kmcv1alpha1.AnnotationCIDR: "10.40.1.0/24"})

	guestIP := &kmcv1alpha1.IPAddress{
		ObjectMeta: metav1.ObjectMeta{Name: "10-40-1-20", Namespace: "default"},
		Spec: kmcv1alpha1.IPAddressSpec{
			Address:      "10.40.1.20",
			PrefixLength: 24,
			PoolRef:      kmcv1alpha1.PoolReference{Kind: "VPC", Name: "app-net"},
			ClaimRef: &corev1.ObjectReference{
				Kind: "VirtualMachine",
				Name: "web-1",
			},
			Interface: &kmcv1alpha1.InterfaceBinding{
				MAC:      "02:aa:bb:cc:dd:ee",
				Hostname: "web-1",
			},
		},
	}
	fip := &kmcv1alpha1.FloatingIP{
		ObjectMeta: metav1.ObjectMeta{Name: "74-82-62-10", Namespace: "default", UID: "fip-1"},
		Spec: kmcv1alpha1.FloatingIPSpec{
			PoolRef:        kmcv1alpha1.PoolReference{Kind: "IPPool", Name: "public"},
			Address:        "74.82.62.10",
			VPCRef:         corev1.LocalObjectReference{Name: "app-net"},
			PrivateAddress: "10.40.1.20",
		},
		Status: kmcv1alpha1.FloatingIPStatus{
			Address:      "74.82.62.10",
			PrefixLength: 27,
		},
	}

	cores := int32(1)
	router := &kmcv1alpha1.Router{
		ObjectMeta: metav1.ObjectMeta{
			Name: "shared", Namespace: "default", Generation: 1, UID: "router-uid-2",
		},
		Spec: kmcv1alpha1.RouterSpec{
			VPCs: []kmcv1alpha1.RouterVPCAttachment{{Name: "app-net"}},
			Appliance: kmcv1alpha1.RouterApplianceSpec{
				Image: kmcv1alpha1.RouterImageRef{Namespace: "vm-images", Name: "ubuntu"},
				CPUCores: &cores, Memory: "1Gi", DiskSize: "10Gi",
				SSHPublicKeys: []string{"ssh-ed25519 AAAA"},
			},
		},
	}
	controllerutil.AddFinalizer(router, kmcv1alpha1.RouterFinalizer)

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&kmcv1alpha1.Router{}, &kmcv1alpha1.IPAddress{}, &kmcv1alpha1.FloatingIP{}).
		WithObjects(vpc, nad, guestIP, fip, router).
		Build()

	r := &RouterReconciler{Client: c, Scheme: scheme, SkipAppliance: true}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: "shared", Namespace: "default"},
	}); err != nil {
		t.Fatal(err)
	}

	var cm corev1.ConfigMap
	if err := c.Get(context.Background(), client.ObjectKey{
		Namespace: "default", Name: rt.ConfigMapName("shared"),
	}, &cm); err != nil {
		t.Fatal(err)
	}
	doc, err := rt.ParsePolicyDoc(cm.Data[kmcv1alpha1.RouterPolicyDataKey])
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Leases) != 1 || doc.Leases[0].IP != "10.40.1.20" {
		t.Fatalf("leases = %+v", doc.Leases)
	}
	if len(doc.FloatingIPs) != 1 || doc.FloatingIPs[0].Private != "10.40.1.20" {
		t.Fatalf("floatingIPs = %+v", doc.FloatingIPs)
	}
}

func TestFloatingIPReady_WhenRouterPolicyReady(t *testing.T) {
	scheme := routerTestScheme(t)
	pool := &kmcv1alpha1.IPPool{
		ObjectMeta: metav1.ObjectMeta{Name: "public"},
		Spec: kmcv1alpha1.IPPoolSpec{
			MultusNetwork: "bridge-external",
			CIDR:          "74.82.62.0/27",
			Gateway:       "74.82.62.1",
		},
	}
	router := &kmcv1alpha1.Router{
		ObjectMeta: metav1.ObjectMeta{Name: "shared", Namespace: "default"},
		Spec: kmcv1alpha1.RouterSpec{
			VPCs: []kmcv1alpha1.RouterVPCAttachment{{Name: "app-net"}},
		},
		Status: kmcv1alpha1.RouterStatus{
			PolicyConfigMap:  "kmc-router-shared",
			PolicyGeneration: 1,
			Agent:            &kmcv1alpha1.RouterAgentStatus{Status: "Ready"},
		},
	}
	fip := &kmcv1alpha1.FloatingIP{
		ObjectMeta: metav1.ObjectMeta{
			Name: "74-82-62-10", Namespace: "default", Generation: 1, UID: "fip-uid",
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
		WithObjects(pool, router, fip).
		Build()

	r := &FloatingIPReconciler{Client: c, Scheme: scheme, Recorder: record.NewFakeRecorder(5)}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: fip.Name, Namespace: fip.Namespace},
	}); err != nil {
		t.Fatal(err)
	}

	var got kmcv1alpha1.FloatingIP
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(fip), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Status.Programmed {
		t.Fatal("expected programmed=true")
	}
	cond := metaFind(got.Status.Conditions, kmcv1alpha1.FloatingIPConditionReady)
	if cond == nil || cond.Status != metav1.ConditionTrue {
		t.Fatalf("ready condition = %+v", cond)
	}
}

func metaFind(conds []metav1.Condition, t string) *metav1.Condition {
	for i := range conds {
		if conds[i].Type == t {
			return &conds[i]
		}
	}
	return nil
}
