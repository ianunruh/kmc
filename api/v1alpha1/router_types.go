package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Router phase values.
const (
	RouterPhasePending = "Pending"
	RouterPhaseReady   = "Ready"
	RouterPhaseError   = "Error"
)

// Condition types for Router.
const (
	RouterConditionReady         = "Ready"
	RouterConditionControlPlane  = "ControlPlaneReady"
	RouterConditionPolicy        = "PolicyReady"
	RouterConditionAppliance     = "ApplianceReady"
	RouterConditionAgent         = "AgentReady"
)

// Finalizer written by the Router controller.
const (
	RouterFinalizer = "kmc.ianunruh.com/router"
)

// Labels / annotations shared with the console router path.
const (
	LabelRole   = "kmc.ianunruh.com/role"
	LabelRouter = "kmc.ianunruh.com/router"
	LabelVPC    = "kmc.ianunruh.com/vpc"

	RoleRouter           = "router"
	ResourceRouterPolicy = "router-policy"

	AnnotationAgentStatus             = "kmc.ianunruh.com/agent-status"
	AnnotationAgentObservedGeneration = "kmc.ianunruh.com/agent-observed-generation"
	AnnotationAgentLastError          = "kmc.ianunruh.com/agent-last-error"
	AnnotationAgentAppliedAt          = "kmc.ianunruh.com/agent-applied-at"
	AnnotationAgentHeartbeatAt        = "kmc.ianunruh.com/agent-heartbeat-at"
	AnnotationAgentVersion            = "kmc.ianunruh.com/agent-version"

	// Max Multus NICs (VPCs + optional external) on a single router appliance.
	MaxMultusAttachments = 8

	// Policy ConfigMap data keys.
	RouterPolicyDataKey  = "policy.json"
	RouterAgentScriptKey = "agent.py"
)

// RouterVPCAttachment is a desired private interface on a shared router.
type RouterVPCAttachment struct {
	// Name of the VPC / Multus NAD in the same namespace.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`

	// Optional gateway IPv4 inside the VPC CIDR. Empty means first usable host.
	// +optional
	Gateway string `json:"gateway,omitempty"`
}

// RouterExternalSpec configures the optional public Multus gateway (SNAT + FIPs).
type RouterExternalSpec struct {
	// Multus network name (or IPPool name when MultusNetwork matches pool id).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	MultusNetwork string `json:"multusNetwork"`

	// Optional preferred public IPv4. Empty means allocate from the matching IPPool.
	// +optional
	Address string `json:"address,omitempty"`

	// SNAT (MASQUERADE) for guest egress. Defaults to true when omitted.
	// +optional
	SNAT *bool `json:"snat,omitempty"`
}

// RouterImageRef points at a golden-image PVC (CDI DataVolume source).
type RouterImageRef struct {
	// Kind of image source. Only "pvc" is supported.
	// +kubebuilder:validation:Enum=pvc
	// +kubebuilder:default=pvc
	// +optional
	Kind string `json:"kind,omitempty"`

	// Namespace of the source PVC (e.g. vm-images).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Namespace string `json:"namespace"`

	// Name of the source PVC.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`
}

// RouterApplianceSpec describes the KubeVirt router VM.
type RouterApplianceSpec struct {
	// Golden image to clone for the root disk.
	// +kubebuilder:validation:Required
	Image RouterImageRef `json:"image"`

	// Optional cluster instance type name.
	// +optional
	InstanceType string `json:"instanceType,omitempty"`

	// CPU cores when not using instanceType.
	// +optional
	// +kubebuilder:validation:Minimum=1
	CPUCores *int32 `json:"cpuCores,omitempty"`

	// Memory quantity when not using instanceType (e.g. 2Gi).
	// +optional
	Memory string `json:"memory,omitempty"`

	// Root disk size (e.g. 20Gi).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	DiskSize string `json:"diskSize"`

	// Optional storage class for the root DataVolume.
	// +optional
	StorageClass string `json:"storageClass,omitempty"`

	// SSH public keys injected via cloud-init.
	// +kubebuilder:validation:MinItems=1
	SSHPublicKeys []string `json:"sshPublicKeys"`

	// KubeVirt run strategy. Defaults to Always.
	// +optional
	// +kubebuilder:validation:Enum=Always;Halted;Manual;RerunOnFailure
	RunStrategy string `json:"runStrategy,omitempty"`
}

// RouterSpec defines the desired state of a shared router.
type RouterSpec struct {
	// VPCs to attach (private Multus interfaces + DHCP/DNS).
	// +kubebuilder:validation:MinItems=1
	VPCs []RouterVPCAttachment `json:"vpcs"`

	// Optional public Multus external gateway.
	// +optional
	External *RouterExternalSpec `json:"external,omitempty"`

	// Appliance sizing, image, and access.
	// +kubebuilder:validation:Required
	Appliance RouterApplianceSpec `json:"appliance"`
}

// RouterInterfaceStatus is an observed private interface.
type RouterInterfaceStatus struct {
	// VPC / NAD name.
	// +optional
	VPC string `json:"vpc,omitempty"`

	// Private CIDR.
	// +optional
	CIDR string `json:"cidr,omitempty"`

	// Gateway IPv4 on this interface.
	// +optional
	Gateway string `json:"gateway,omitempty"`

	// MAC address assigned to the Multus NIC.
	// +optional
	MAC string `json:"mac,omitempty"`

	// DHCP domain (e.g. app-net.vpc.local).
	// +optional
	Domain string `json:"domain,omitempty"`
}

// RouterExternalStatus is the observed external gateway.
type RouterExternalStatus struct {
	// Multus network name.
	// +optional
	MultusNetwork string `json:"multusNetwork,omitempty"`

	// Primary public address/prefix (e.g. 74.82.62.10/27).
	// +optional
	PrimaryCIDR string `json:"primaryCidr,omitempty"`

	// Public default gateway.
	// +optional
	Gateway string `json:"gateway,omitempty"`

	// MAC of the external Multus NIC.
	// +optional
	MAC string `json:"mac,omitempty"`

	// Whether SNAT is enabled.
	// +optional
	SNAT bool `json:"snat,omitempty"`
}

// RouterAgentStatus mirrors agent annotations on the policy ConfigMap.
type RouterAgentStatus struct {
	// Ready | Pending | Error | Stale
	// +optional
	Status string `json:"status,omitempty"`

	// Agent-reported observed policy generation.
	// +optional
	ObservedGeneration string `json:"observedGeneration,omitempty"`

	// Last agent error message.
	// +optional
	LastError string `json:"lastError,omitempty"`

	// Last successful apply timestamp (RFC3339).
	// +optional
	AppliedAt string `json:"appliedAt,omitempty"`

	// Last heartbeat timestamp (RFC3339).
	// +optional
	HeartbeatAt string `json:"heartbeatAt,omitempty"`

	// Agent version / script hash prefix.
	// +optional
	Version string `json:"version,omitempty"`
}

// RouterStatus defines the observed state of Router.
type RouterStatus struct {
	// Phase is a high-level summary: Pending, Ready, or Error.
	// +optional
	Phase string `json:"phase,omitempty"`

	// PolicyConfigMap is the name of the owned policy ConfigMap.
	// +optional
	PolicyConfigMap string `json:"policyConfigMap,omitempty"`

	// PolicyGeneration is the generation embedded in policy.json metadata.
	// +optional
	PolicyGeneration int64 `json:"policyGeneration,omitempty"`

	// Observed private interfaces.
	// +optional
	Interfaces []RouterInterfaceStatus `json:"interfaces,omitempty"`

	// Observed external gateway.
	// +optional
	External *RouterExternalStatus `json:"external,omitempty"`

	// Appliance VirtualMachine name (same namespace).
	// +optional
	VMName string `json:"vmName,omitempty"`

	// Appliance VM printable status when known.
	// +optional
	VMStatus string `json:"vmStatus,omitempty"`

	// ApplianceReady is true when the VirtualMachine exists and is Ready.
	// +optional
	VMReady bool `json:"vmReady,omitempty"`

	// VMMissing is true when the policy exists but the appliance VM does not.
	// +optional
	VMMissing bool `json:"vmMissing,omitempty"`

	// Agent status projected from policy ConfigMap annotations.
	// +optional
	Agent *RouterAgentStatus `json:"agent,omitempty"`

	// ObservedGeneration is the .metadata.generation last processed.
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
// +kubebuilder:resource:shortName=rtr
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="VPCs",type=string,JSONPath=`.status.interfaces[*].vpc`
// +kubebuilder:printcolumn:name="External",type=string,JSONPath=`.status.external.primaryCidr`
// +kubebuilder:printcolumn:name="Agent",type=string,JSONPath=`.status.agent.status`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// Router is a namespaced shared router (DHCP/DNS gateway + optional external SNAT).
// It owns the policy ConfigMap, agent RBAC, gateway IPAddress claims, and the
// KubeVirt appliance VirtualMachine. FloatingIP and PortForward CRs are projected
// into the policy document; DHCP leases project from IPAddress.spec.interface.
//
// GVK: routers.kmc.ianunruh.com (shortName rtr).
type Router struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   RouterSpec   `json:"spec,omitempty"`
	Status RouterStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// RouterList contains a list of Router.
type RouterList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Router `json:"items"`
}

// RouterLocalRef is a convenience for LocalObjectReference to this router.
func RouterLocalRef(name string) *corev1.LocalObjectReference {
	return &corev1.LocalObjectReference{Name: name}
}

func init() {
	SchemeBuilder.Register(&Router{}, &RouterList{})
}
