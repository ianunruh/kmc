package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// VLANPool phase values.
const (
	VLANPoolPhasePending = "Pending"
	VLANPoolPhaseReady   = "Ready"
)

// Condition types for VLANPool.
const (
	VLANPoolConditionReady = "Ready"
)

// Finalizer written by the VLANPool controller.
const (
	VLANPoolFinalizer = "kmc.ianunruh.com/vlanpool"
)

// VLANPoolSpec defines an operator-managed VLAN id range for self-service VPCs.
type VLANPoolSpec struct {
	// Inclusive start VLAN id (1–4094).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=4094
	Start int32 `json:"start"`

	// Inclusive end VLAN id (1–4094).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=4094
	End int32 `json:"end"`

	// Hypervisor Linux bridge that carries these VLANs (e.g. br0).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Bridge string `json:"bridge"`

	// Default DNS resolvers for VPC private IPAM when the VPC does not set dns.
	// +optional
	DNS []string `json:"dns,omitempty"`

	// VLAN ids never allocated (hand-managed segments already in the range).
	// +optional
	Exclude []int32 `json:"exclude,omitempty"`
}

// VLANPoolStatus defines the observed state of VLANPool.
type VLANPoolStatus struct {
	// Phase is a high-level summary: Pending or Ready.
	// +optional
	Phase string `json:"phase,omitempty"`

	// Allocated is the number of VPCs currently holding a VLAN from this pool.
	// +optional
	Allocated int32 `json:"allocated,omitempty"`

	// Available is free VLANs remaining (range size minus exclude minus allocated).
	// +optional
	Available int32 `json:"available,omitempty"`

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
// +kubebuilder:resource:scope=Cluster,shortName=vlanpool
// +kubebuilder:printcolumn:name="Start",type=integer,JSONPath=`.spec.start`
// +kubebuilder:printcolumn:name="End",type=integer,JSONPath=`.spec.end`
// +kubebuilder:printcolumn:name="Bridge",type=string,JSONPath=`.spec.bridge`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// VLANPool is a cluster-scoped pool of 802.1Q VLAN ids for self-service VPCs.
// Object name is the pool id (e.g. "default"), matching clusters.yaml vlanPools[].id.
type VLANPool struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   VLANPoolSpec   `json:"spec,omitempty"`
	Status VLANPoolStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// VLANPoolList contains a list of VLANPool.
type VLANPoolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []VLANPool `json:"items"`
}

func init() {
	SchemeBuilder.Register(&VLANPool{}, &VLANPoolList{})
}
