package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// FloatingIP phase values.
const (
	FloatingIPPhasePending    = "Pending"
	FloatingIPPhaseHeld       = "Held"
	FloatingIPPhaseAssociated = "Associated"
	FloatingIPPhaseError      = "Error"
)

// Condition types for FloatingIP.
const (
	FloatingIPConditionReady = "Ready"
)

// Finalizer written by the FloatingIP controller.
const (
	FloatingIPFinalizer = "kmc.ianunruh.com/floatingip"
)

// FloatingIPSpec defines a public floating address for a VPC.
// Realization (SNAT/DNAT on the appliance) requires a future Router controller.
type FloatingIPSpec struct {
	// PoolRef identifies the public IPv4 pool (typically kind IPPool).
	// +kubebuilder:validation:Required
	PoolRef PoolReference `json:"poolRef"`

	// Optional preferred public IPv4 address. Empty means allocate (via IPAddress claim later).
	// +optional
	Address string `json:"address,omitempty"`

	// VPC this floating IP belongs to (same namespace).
	// +kubebuilder:validation:Required
	VPCRef corev1.LocalObjectReference `json:"vpcRef"`

	// Router that should program SNAT/DNAT. Reserved for the Router CR; Ready
	// stays false until a Router controller exists and sets status.programmed.
	// +optional
	RouterRef *corev1.LocalObjectReference `json:"routerRef,omitempty"`

	// Private VPC address when associated. Empty means held (public reserved, unmapped).
	// +optional
	PrivateAddress string `json:"privateAddress,omitempty"`

	// Optional target VirtualMachine (same namespace) for the private address.
	// +optional
	TargetVM *corev1.LocalObjectReference `json:"targetVM,omitempty"`
}

// FloatingIPStatus defines the observed state of FloatingIP.
type FloatingIPStatus struct {
	// Phase: Pending, Held, Associated, or Error.
	// +optional
	Phase string `json:"phase,omitempty"`

	// Allocated public address (dotted-quad).
	// +optional
	Address string `json:"address,omitempty"`

	// Prefix length of the public address on the external Multus NIC.
	// +optional
	PrefixLength int32 `json:"prefixLength,omitempty"`

	// Programmed is true when a future Router controller has applied this mapping.
	// +optional
	Programmed bool `json:"programmed,omitempty"`

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
// +kubebuilder:resource:shortName=fip
// +kubebuilder:printcolumn:name="Address",type=string,JSONPath=`.status.address`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="VPC",type=string,JSONPath=`.spec.vpcRef.name`
// +kubebuilder:printcolumn:name="Private",type=string,JSONPath=`.spec.privateAddress`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// FloatingIP is a namespaced public floating IPv4 for a VPC (hold or associate).
// Recommended object name: public address with dots → dashes (10-20-30-40).
//
// Until the Router CR exists, the controller only validates and sets Held/Associated
// from the spec; Ready remains false (RouterNotImplemented).
type FloatingIP struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   FloatingIPSpec   `json:"spec,omitempty"`
	Status FloatingIPStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// FloatingIPList contains a list of FloatingIP.
type FloatingIPList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []FloatingIP `json:"items"`
}

func init() {
	SchemeBuilder.Register(&FloatingIP{}, &FloatingIPList{})
}
