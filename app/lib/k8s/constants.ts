/** Kubernetes label namespace owned by kmc. */
export const KMC_LABEL_NAMESPACE = "kmc.ianunruh.com";

/** Standard ownership label value written on kmc-managed objects. */
export const KMC_MANAGED_BY = "kmc";
export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";

/**
 * Namespaces labeled with this key (value `"true"`) appear in the launch/create
 * namespace pickers and are accepted by createVm.
 */
export const VM_ALLOWED_LABEL = `${KMC_LABEL_NAMESPACE}/vm-allowed`;

export const VM_ALLOWED_LABEL_SELECTOR = `${VM_ALLOWED_LABEL}=true`;

/**
 * Golden image PVCs labeled with this key name a VirtualMachineClusterPreference
 * applied automatically when launching a VM from that image.
 */
export const IMAGE_PREFERENCE_LABEL = `${KMC_LABEL_NAMESPACE}/cluster-preference`;

/** Target VirtualMachine name for kmc-managed Service / Ingress exposure. */
export const KMC_LABEL_VM = `${KMC_LABEL_NAMESPACE}/vm`;

/**
 * What a kmc-managed Service/Ingress is bound to.
 * v1: `VirtualMachine`; future: label selector / group.
 */
export const KMC_LABEL_TARGET_KIND = `${KMC_LABEL_NAMESPACE}/target-kind`;
export const KMC_TARGET_KIND_VM = "VirtualMachine";

/** Ingress name stamped on the companion Service for reverse lookup. */
export const KMC_LABEL_INGRESS = `${KMC_LABEL_NAMESPACE}/ingress`;

/** List selector for kmc-managed Ingresses bound to a single VM. */
export const KMC_INGRESS_LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${KMC_MANAGED_BY},${KMC_LABEL_TARGET_KIND}=${KMC_TARGET_KIND_VM}`;

/** Value of kmc.ianunruh.com/resource for self-service VPC NADs. */
export const KMC_RESOURCE_VPC = "vpc";

/** Labels on kmc-managed VPC NetworkAttachmentDefinitions. */
export const KMC_LABEL_RESOURCE = `${KMC_LABEL_NAMESPACE}/resource`;
export const KMC_LABEL_VLAN = `${KMC_LABEL_NAMESPACE}/vlan`;
export const KMC_LABEL_VLAN_POOL = `${KMC_LABEL_NAMESPACE}/vlan-pool`;

/** Annotations on kmc-managed VPC NADs (optional IPAM + metadata). */
export const KMC_ANN_CIDR = `${KMC_LABEL_NAMESPACE}/cidr`;
export const KMC_ANN_GATEWAY = `${KMC_LABEL_NAMESPACE}/gateway`;
export const KMC_ANN_DNS = `${KMC_LABEL_NAMESPACE}/dns`;
export const KMC_ANN_DESCRIPTION = `${KMC_LABEL_NAMESPACE}/description`;
export const KMC_ANN_OWNER = `${KMC_LABEL_NAMESPACE}/owner`;
/** VM name (same namespace) of the dual-homed NAT gateway for this VPC. */
export const KMC_ANN_NAT_GATEWAY = `${KMC_LABEL_NAMESPACE}/nat-gateway`;

/** VM role labels (e.g. NAT gateway for a VPC). */
export const KMC_LABEL_ROLE = `${KMC_LABEL_NAMESPACE}/role`;
export const KMC_ROLE_NAT_GATEWAY = "nat-gateway";
/** VPC NAD name (same namespace as the VM) this role serves. */
export const KMC_LABEL_VPC = `${KMC_LABEL_NAMESPACE}/vpc`;

/** List selector for kmc-managed VPC NADs. */
export const KMC_VPC_LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${KMC_MANAGED_BY},${KMC_LABEL_RESOURCE}=${KMC_RESOURCE_VPC}`;
