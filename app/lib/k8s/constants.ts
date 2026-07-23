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

/** Value of kmc.ianunruh.com/resource for static/shared Multus NADs (from ipPools). */
export const KMC_RESOURCE_NETWORK = "network";

/** Labels on kmc-managed VPC NetworkAttachmentDefinitions. */
export const KMC_LABEL_RESOURCE = `${KMC_LABEL_NAMESPACE}/resource`;
export const KMC_LABEL_VLAN = `${KMC_LABEL_NAMESPACE}/vlan`;
export const KMC_LABEL_VLAN_POOL = `${KMC_LABEL_NAMESPACE}/vlan-pool`;
/** Static ipPools id stamped on ensured shared Multus NADs. */
export const KMC_LABEL_IP_POOL = `${KMC_LABEL_NAMESPACE}/ip-pool`;

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

/** Value of kmc.ianunruh.com/resource for NAT gateway policy ConfigMaps. */
export const KMC_RESOURCE_NAT_POLICY = "nat-policy";

/** List selector for kmc-managed VPC NADs. */
export const KMC_VPC_LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${KMC_MANAGED_BY},${KMC_LABEL_RESOURCE}=${KMC_RESOURCE_VPC}`;

/** List selector for NAT gateway policy ConfigMaps (floating IPs, etc.). */
export const KMC_NAT_POLICY_LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${KMC_MANAGED_BY},${KMC_LABEL_RESOURCE}=${KMC_RESOURCE_NAT_POLICY}`;

/** Policy ConfigMap data key (JSON NatGatewayPolicy). */
export const KMC_NAT_POLICY_DATA_KEY = "policy.json";

/**
 * Policy ConfigMap data key for the in-guest agent source (Python).
 * Agents self-update when this key changes.
 */
export const KMC_NAT_AGENT_SCRIPT_KEY = "agent.py";

/** Agent status annotations on the policy ConfigMap. */
export const KMC_ANN_AGENT_STATUS = `${KMC_LABEL_NAMESPACE}/agent-status`;
export const KMC_ANN_AGENT_OBSERVED_GENERATION = `${KMC_LABEL_NAMESPACE}/agent-observed-generation`;
export const KMC_ANN_AGENT_LAST_ERROR = `${KMC_LABEL_NAMESPACE}/agent-last-error`;
export const KMC_ANN_AGENT_APPLIED_AT = `${KMC_LABEL_NAMESPACE}/agent-applied-at`;
/** Periodic liveness timestamp written by the agent (watch/heartbeat). */
export const KMC_ANN_AGENT_HEARTBEAT_AT = `${KMC_LABEL_NAMESPACE}/agent-heartbeat-at`;
/** Short sha256 prefix of the running agent script. */
export const KMC_ANN_AGENT_VERSION = `${KMC_LABEL_NAMESPACE}/agent-version`;

/**
 * If the agent heartbeat is older than this, surface status as Stale.
 * Default agent heartbeat interval is 30s; 90s ≈ 3 missed beats.
 */
export const KMC_NAT_AGENT_STALE_AFTER_MS = 90_000;

/**
 * Comma-separated floating public IPv4s held by a NAT gateway (IPAM scan).
 * May include /prefix; used so secondary floats are not double-allocated.
 */
export const KMC_ANN_FLOATING_IPV4 = `${KMC_LABEL_NAMESPACE}/floating-ipv4`;
