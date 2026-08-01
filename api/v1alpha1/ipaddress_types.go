package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// IPAddress phase values.
const (
	IPAddressPhasePending  = "Pending"
	IPAddressPhaseBound    = "Bound"
	IPAddressPhaseReleased = "Released"
)

// Condition types for IPAddress.
const (
	IPAddressConditionReady = "Ready"
)

// Finalizer written by the IPAddress controller.
const (
	IPAddressFinalizer = "kmc.ianunruh.com/ipaddress"
)

// Labels recommended on IPAddress objects.
const (
	LabelAddress = "kmc.ianunruh.com/address"
	LabelPool    = "kmc.ianunruh.com/pool"
)

// PoolReference points at a pool-like resource.
// Allowed kinds today: "VPC" (namespaced), "IPPool" (cluster-scoped).
type PoolReference struct {
	// Kind of pool. Allowed: "VPC", "IPPool".
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:Enum=VPC;IPPool
	Kind string `json:"kind"`

	// Name of the pool resource (namespaced for VPC; cluster-scoped for IPPool).
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`
}

// InterfaceBinding holds guest NIC details used for DHCP lease projection.
type InterfaceBinding struct {
	// MAC address of the guest interface (e.g. for dnsmasq dhcp-host).
	// +optional
	MAC string `json:"mac,omitempty"`

	// Hostname advertised via DHCP.
	// +optional
	Hostname string `json:"hostname,omitempty"`
}

// IPAddressSpec defines the desired state of IPAddress.
type IPAddressSpec struct {
	// Address is the IPv4 address being claimed.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Address string `json:"address"`

	// PrefixLength is the CIDR prefix length for the address (0–32).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=32
	PrefixLength int32 `json:"prefixLength"`

	// PoolRef identifies the pool this address was taken from.
	// +kubebuilder:validation:Required
	PoolRef PoolReference `json:"poolRef"`

	// ClaimRef is the object that owns this allocation (VM, FloatingIP, Router, …).
	// +optional
	ClaimRef *corev1.ObjectReference `json:"claimRef,omitempty"`

	// Interface holds optional guest NIC metadata for DHCP.
	// +optional
	Interface *InterfaceBinding `json:"interface,omitempty"`
}

// IPAddressStatus defines the observed state of IPAddress.
type IPAddressStatus struct {
	// Phase is a high-level summary: Pending, Bound, or Released.
	// +optional
	Phase string `json:"phase,omitempty"`

	// Gateway is the default gateway for this address when known.
	// +optional
	Gateway string `json:"gateway,omitempty"`

	// DNS is the resolver list for this address when known.
	// +optional
	DNS []string `json:"dns,omitempty"`

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
// +kubebuilder:resource:shortName=ipaddr
// +kubebuilder:printcolumn:name="Address",type=string,JSONPath=`.spec.address`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Pool",type=string,JSONPath=`.spec.poolRef.name`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// IPAddress is a single allocated IPv4 address. Create is the allocation race:
// use a deterministic name (dots → dashes, e.g. 10-40-1-20) so concurrent
// creates collide with HTTP 409.
type IPAddress struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   IPAddressSpec   `json:"spec,omitempty"`
	Status IPAddressStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// IPAddressList contains a list of IPAddress.
type IPAddressList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []IPAddress `json:"items"`
}

func init() {
	SchemeBuilder.Register(&IPAddress{}, &IPAddressList{})
}
