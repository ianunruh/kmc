package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// VPC phase values.
const (
	VPCPhasePending = "Pending"
	VPCPhaseReady   = "Ready"
	VPCPhaseError   = "Error"
)

// Condition types for VPC.
const (
	VPCConditionReady = "Ready"
)

// Finalizer written by the VPC controller.
const (
	VPCFinalizer = "kmc.ianunruh.com/vpc"
)

// Labels written on Multus NetworkAttachmentDefinitions owned by a VPC or static IPPool.
const (
	LabelResource = "kmc.ianunruh.com/resource"
	LabelVLAN     = "kmc.ianunruh.com/vlan"
	LabelVLANPool = "kmc.ianunruh.com/vlan-pool"
	// LabelIPPool is stamped on static/shared Multus NADs from IPPool.spec.cni.
	LabelIPPool    = "kmc.ianunruh.com/ip-pool"
	LabelManagedBy = "app.kubernetes.io/managed-by"
	ManagedByKMC   = "kmc"
	ResourceVPC    = "vpc"
	// ResourceNetwork marks static Multus NADs materialised from IPPool CNI templates.
	ResourceNetwork = "network"
)

// Annotations on Multus NADs / reserved for future Router attachment.
const (
	AnnotationCIDR        = "kmc.ianunruh.com/cidr"
	AnnotationGateway     = "kmc.ianunruh.com/gateway"
	AnnotationDNS         = "kmc.ianunruh.com/dns"
	AnnotationDescription = "kmc.ianunruh.com/description"
	// AnnotationRouter is set by the Router controller (same-namespace router name).
	AnnotationRouter = "kmc.ianunruh.com/router"
)

// VPCSpec defines the desired state of a self-service private network.
// One optional private CIDR (subnet) per VPC — matches the console product model.
type VPCSpec struct {
	// VLANPoolRef names a cluster-scoped VLANPool to allocate a VLAN from.
	// +kubebuilder:validation:Required
	VLANPoolRef corev1.LocalObjectReference `json:"vlanPoolRef"`

	// Optional private IPv4 CIDR for IPAM on this VPC (e.g. 10.40.1.0/24).
	// +optional
	CIDR string `json:"cidr,omitempty"`

	// Optional default gateway inside the CIDR (often the future router interface IP).
	// +optional
	Gateway string `json:"gateway,omitempty"`

	// Optional DNS resolvers for guests on this VPC.
	// +optional
	DNS []string `json:"dns,omitempty"`

	// Human-readable description.
	// +optional
	Description string `json:"description,omitempty"`
}

// VPCStatus defines the observed state of VPC.
type VPCStatus struct {
	// Phase is a high-level summary: Pending, Ready, or Error.
	// +optional
	Phase string `json:"phase,omitempty"`

	// VLAN assigned from the VLANPool (immutable once set).
	// +optional
	VLAN int32 `json:"vlan,omitempty"`

	// Bridge copied from the VLANPool at assignment time.
	// +optional
	Bridge string `json:"bridge,omitempty"`

	// NetworkAttachmentReady is true when the owned Multus NAD exists and matches.
	// +optional
	NetworkAttachmentReady bool `json:"networkAttachmentReady,omitempty"`

	// RouterRef is set when a shared router attaches to this VPC (mirrors
	// annotation kmc.ianunruh.com/router on the Multus NAD).
	// +optional
	RouterRef *corev1.LocalObjectReference `json:"routerRef,omitempty"`

	// ObservedGeneration is the .metadata.generation last processed by the controller.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Conditions represent the latest available observations.
	// +optional
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=vpc
// +kubebuilder:printcolumn:name="VLAN",type=integer,JSONPath=`.status.vlan`
// +kubebuilder:printcolumn:name="CIDR",type=string,JSONPath=`.spec.cidr`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Pool",type=string,JSONPath=`.spec.vlanPoolRef.name`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// VPC is a namespaced self-service private network (Multus bridge + VLAN).
// Object name is the Multus NetworkAttachmentDefinition name tenants attach VMs to.
//
// Router attachment is out of band: the Router controller sets
// annotation kmc.ianunruh.com/router; the VPC controller mirrors status.routerRef.
type VPC struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   VPCSpec   `json:"spec,omitempty"`
	Status VPCStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// VPCList contains a list of VPC.
type VPCList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []VPC `json:"items"`
}

func init() {
	SchemeBuilder.Register(&VPC{}, &VPCList{})
}
