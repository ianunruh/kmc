package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// IPPool phase values.
const (
	IPPoolPhasePending = "Pending"
	IPPoolPhaseReady   = "Ready"
)

// Condition types for IPPool.
const (
	IPPoolConditionReady = "Ready"
)

// Finalizer written by the IPPool controller.
const (
	IPPoolFinalizer = "kmc.ianunruh.com/ippool"
)

// IPPoolCNISpec is an optional Multus CNI template for shared/public networks.
// When set, consumers may create a NetworkAttachmentDefinition in a tenant
// namespace from this template if missing (ensure-on-create).
type IPPoolCNISpec struct {
	// CNI plugin type (typically "bridge").
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Type string `json:"type"`

	// Linux bridge on hypervisors (e.g. br-external).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Bridge string `json:"bridge"`

	// Optional 802.1Q VLAN id on the bridge.
	// +optional
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=4094
	VLAN *int32 `json:"vlan,omitempty"`
}

// IPPoolSpec defines a cluster-scoped IPv4 pool bound to a Multus network.
// Referenced by IPAddress.poolRef with kind "IPPool".
type IPPoolSpec struct {
	// Multus NetworkAttachmentDefinition this pool serves.
	// Accepts "bridge-external" or "namespace/bridge-external".
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	MultusNetwork string `json:"multusNetwork"`

	// IPv4 CIDR for the pool (e.g. 74.82.62.0/27).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	CIDR string `json:"cidr"`

	// Default gateway for guest routes. Optional for pure-L2 pools.
	// +optional
	Gateway string `json:"gateway,omitempty"`

	// DNS resolvers advertised to guests.
	// +optional
	DNS []string `json:"dns,omitempty"`

	// Addresses never allocated (routers, VIPs, etc.).
	// +optional
	Exclude []string `json:"exclude,omitempty"`

	// Optional allocation window start (IPv4) within the CIDR.
	// +optional
	Start string `json:"start,omitempty"`

	// Optional allocation window end (IPv4) within the CIDR.
	// +optional
	End string `json:"end,omitempty"`

	// Guest interface name for netplan match (e.g. enp1s0).
	// +optional
	Interface string `json:"interface,omitempty"`

	// Optional CNI template to materialize a Multus NAD in tenant namespaces.
	// +optional
	CNI *IPPoolCNISpec `json:"cni,omitempty"`
}

// IPPoolStatus defines the observed state of IPPool.
type IPPoolStatus struct {
	// Phase is a high-level summary: Pending or Ready.
	// +optional
	Phase string `json:"phase,omitempty"`

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
// +kubebuilder:resource:scope=Cluster,shortName=ippool
// +kubebuilder:printcolumn:name="CIDR",type=string,JSONPath=`.spec.cidr`
// +kubebuilder:printcolumn:name="Network",type=string,JSONPath=`.spec.multusNetwork`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// IPPool is a cluster-scoped IPv4 allocation pool for Multus networks.
// Object name is the pool id (e.g. "public"), matching clusters.yaml ipPools[].id
// and IPAddress.spec.poolRef.name when kind is IPPool.
type IPPool struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   IPPoolSpec   `json:"spec,omitempty"`
	Status IPPoolStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// IPPoolList contains a list of IPPool.
type IPPoolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []IPPool `json:"items"`
}

func init() {
	SchemeBuilder.Register(&IPPool{}, &IPPoolList{})
}
