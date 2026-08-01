package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// PortForward phase values.
const (
	PortForwardPhasePending = "Pending"
	PortForwardPhaseReady   = "Ready"
	PortForwardPhaseError   = "Error"
)

// Condition types for PortForward.
const (
	PortForwardConditionReady = "Ready"
)

// Finalizer written by the PortForward controller.
const (
	PortForwardFinalizer = "kmc.ianunruh.com/portforward"
)

// PortForward protocol values.
const (
	PortForwardProtocolTCP = "TCP"
	PortForwardProtocolUDP = "UDP"
)

// PortForwardSpec defines a port-level DNAT rule through a router external gateway.
// Distinct from FloatingIP (full 1:1): multiple PortForwards may share one public address.
// Realization is done by the Router controller (policy projection + agent).
type PortForwardSpec struct {
	// VPC that owns the private address (same namespace).
	// +kubebuilder:validation:Required
	VPCRef corev1.LocalObjectReference `json:"vpcRef"`

	// Router that should program DNAT. When empty, the Router attaching the VPC is used.
	// +optional
	RouterRef *corev1.LocalObjectReference `json:"routerRef,omitempty"`

	// Public listen address (no prefix).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	PublicAddress string `json:"publicAddress"`

	// Public listen port.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	PublicPort int32 `json:"publicPort"`

	// Private target address in the VPC (no prefix).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	PrivateAddress string `json:"privateAddress"`

	// Private target port.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	PrivatePort int32 `json:"privatePort"`

	// Protocol: TCP or UDP.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Enum=TCP;UDP
	Protocol string `json:"protocol"`

	// Optional target VirtualMachine (same namespace).
	// +optional
	TargetVM *corev1.LocalObjectReference `json:"targetVM,omitempty"`
}

// PortForwardStatus defines the observed state of PortForward.
type PortForwardStatus struct {
	// Phase: Pending, Ready, or Error.
	// +optional
	Phase string `json:"phase,omitempty"`

	// Programmed is true when a Router has projected this rule into policy.
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
// +kubebuilder:resource:shortName=pf
// +kubebuilder:printcolumn:name="Public",type=string,JSONPath=`.spec.publicAddress`
// +kubebuilder:printcolumn:name="Port",type=integer,JSONPath=`.spec.publicPort`
// +kubebuilder:printcolumn:name="Protocol",type=string,JSONPath=`.spec.protocol`
// +kubebuilder:printcolumn:name="Private",type=string,JSONPath=`.spec.privateAddress`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// PortForward is a namespaced port DNAT rule (publicIP:port → privateIP:port).
// The PortForward controller validates; the Router controller projects DNAT
// into policy. Ready is true when the agent is Ready.
//
// A public address must not be both a full FloatingIP association and a
// PortForward host — the Router render prefers the FloatingIP association.
type PortForward struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   PortForwardSpec   `json:"spec,omitempty"`
	Status PortForwardStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// PortForwardList contains a list of PortForward.
type PortForwardList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []PortForward `json:"items"`
}

func init() {
	SchemeBuilder.Register(&PortForward{}, &PortForwardList{})
}
