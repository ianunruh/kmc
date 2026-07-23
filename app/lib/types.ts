export type ClusterId = string;

export interface ClusterInfo {
  id: ClusterId;
  reachable: boolean;
  error?: string;
  hasInstanceTypes: boolean;
  defaultStorageClass?: string;
}

/** Kubernetes Event (core/v1) projected for detail UIs */
export interface ResourceEvent {
  type: string;
  reason: string;
  message: string;
  source?: string;
  count: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  involvedKind?: string;
  involvedName?: string;
}

export interface VmSummary {
  cluster: ClusterId;
  namespace: string;
  name: string;
  status: string;
  ready: boolean;
  running: boolean;
  /** Guest CPU label, e.g. `2c` (from domain or instance type). */
  cpu?: string;
  /** Guest memory, e.g. `4Gi` (from domain or instance type). */
  memory?: string;
  /** Root disk size from the primary dataVolumeTemplate when present. */
  disk?: string;
  /**
   * DataVolume name for the primary root disk (same namespace as the VM).
   * Used to link the list disk column when the size comes from a template.
   */
  diskDataVolume?: string;
  /** Cluster instance type name when the VM references one. */
  instanceType?: string;
  /** Static IP from kmc.ianunruh.com/ipv4 (may include /prefix). */
  allocatedIpv4?: string;
  /** Public floating IPs associated with this VM (from NAT policy ConfigMaps). */
  floatingIpv4?: string[];
  age: string;
  nodeName?: string;
  message?: string;
  /**
   * True when KubeVirt reports RestartRequired (e.g. LiveUpdate applied a change
   * that still needs a guest reboot).
   */
  restartRequired?: boolean;
  restartRequiredMessage?: string;
}

export interface VmCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface VmVolumeInfo {
  name: string;
  kind: string;
  detail?: string;
  diskBus?: string;
  size?: string;
  storageClass?: string;
  /**
   * Target resource name for in-app links (DataVolume name, PVC claim name).
   * Namespace is the VM's namespace unless noted otherwise.
   */
  linkName?: string;
}

export interface VmNetworkInfo {
  name: string;
  model?: string;
  /** Interface binding: masquerade, bridge, sriov, … */
  binding?: string;
  multusNetworkName?: string;
  pod?: boolean;
  mac?: string;
  ipAddresses?: string[];
  /** Guest-side NIC name from qemu-guest-agent (e.g. enp1s0). */
  guestInterfaceName?: string;
  /** Link state from VMI status (up/down). */
  linkState?: string;
  /**
   * When the Multus attachment is a kmc-managed VPC NAD, coordinates for the
   * VPC detail page (resolved relative to the VM namespace for bare names).
   */
  vpc?: { cluster: string; namespace: string; name: string };
}

/** Filesystem row from guestosinfo / filesystemlist subresource. */
export interface VmGuestFilesystem {
  mountPoint: string;
  diskName?: string;
  fileSystemType?: string;
  totalBytes?: number;
  usedBytes?: number;
}

/**
 * Guest agent snapshot: VMI status.guestOSInfo + guestosinfo subresource
 * (hostname, timezone, agent version, filesystems) when AgentConnected.
 */
export interface VmGuestAgentInfo {
  /** AgentConnected condition is True. */
  connected: boolean;
  hostname?: string;
  guestAgentVersion?: string;
  timezone?: string;
  osId?: string;
  osPrettyName?: string;
  osName?: string;
  osVersion?: string;
  osVersionId?: string;
  osKernelRelease?: string;
  osKernelVersion?: string;
  /** Guest-reported machine arch, e.g. x86_64. */
  osMachine?: string;
  filesystems?: VmGuestFilesystem[];
}

export interface VmDetail extends VmSummary {
  uid?: string;
  runStrategy?: string;
  instanceType?: string;
  preference?: string;
  machineType?: string;
  architecture?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  conditions: VmCondition[];
  volumes: VmVolumeInfo[];
  networks: VmNetworkInfo[];
  /** Live guest/VMI IPv4 when reported */
  ipv4Address?: string;
  vmiPhase?: string;
  hasVmi: boolean;
  /** QEMU guest agent fields from the live VMI, when present. */
  guestAgent?: VmGuestAgentInfo;
}

export interface CreateVmRequest {
  cluster: ClusterId;
  namespace: string;
  name: string;
  instanceType?: string;
  cpuCores?: number;
  memory?: string;
  preference?: string;
  diskSize: string;
  storageClass?: string;
  image: {
    kind: "pvc";
    namespace: string;
    name: string;
  };
  /**
   * Multus network attachments in order (first is primary for default route when IPAM applies).
   * Empty / omit → pod network only.
   */
  networks?: Array<{
    multusNetworkName: string;
  }>;
  sshPublicKey: string;
  start?: boolean;
  /**
   * When true, cloud-init installs and enables qemu-guest-agent (soft reboot,
   * guest OS info). Requires guest package repos on first boot.
   */
  installGuestAgent?: boolean;
}

/**
 * VM edit surface.
 * - labels: always mutable
 * - spec (runStrategy / size / preference): when stopped, or while running with
 *   LiveUpdate (default on modern KubeVirt). A change that cannot apply live
 *   surfaces as RestartRequired on the VM.
 */
export interface UpdateVmRequest {
  cluster: ClusterId;
  namespace: string;
  name: string;
  labels: Record<string, string>;
  /** Omitted when the VM is in a state that cannot accept template edits. */
  spec?: {
    runStrategy: string;
    sizeMode: "manual" | "instancetype";
    instanceType?: string;
    /** Empty / omit clears the preference matcher. */
    preference?: string;
    cpuCores?: number;
    memory?: string;
  };
}

export const VM_RUN_STRATEGIES = [
  "Always",
  "RerunOnFailure",
  "Manual",
  "Halted",
  "Once",
] as const;

export type VmRunStrategy = (typeof VM_RUN_STRATEGIES)[number];

export interface NamespaceInfo {
  name: string;
}

// --- Namespaces (projects) — vm-allowed opt-in ---

export interface NamespaceSummary {
  cluster: ClusterId;
  name: string;
  phase: string;
  age: string;
  /** True when stamped app.kubernetes.io/managed-by=kmc */
  managedByKmc: boolean;
}

export interface NamespaceDetail extends NamespaceSummary {
  uid?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  /** VirtualMachines in this namespace (same cluster) */
  vmCount: number;
}

export interface CreateNamespaceRequest {
  cluster: ClusterId;
  name: string;
}

export interface InstanceTypeInfo {
  name: string;
  cpu?: string;
  memory?: string;
  /** common-instancetypes class, e.g. general.purpose, memory.intensive */
  class?: string;
  /** common-instancetypes size label, e.g. medium, xlarge */
  size?: string;
  /** e.g. kubevirt.io when from common-instancetypes */
  vendor?: string;
}

export interface PreferenceInfo {
  name: string;
}

export interface StorageClassInfo {
  name: string;
  isDefault: boolean;
  provisioner?: string;
}

export interface ImageInfo {
  name: string;
  namespace: string;
  capacity?: string;
  storageClass?: string;
  /** VirtualMachineClusterPreference from kmc.ianunruh.com/cluster-preference */
  preference?: string;
}

export interface NetworkIpPoolInfo {
  id: string;
  cidr: string;
  free: number;
  total: number;
  gateway?: string;
}

export interface NetworkInfo {
  name: string;
  namespace: string;
  /** Present when this Multus NAD is bound to a configured IP pool */
  ipPool?: NetworkIpPoolInfo;
  /** Self-service VPC vs hand-managed Multus NAD */
  kind?: "vpc" | "multus";
  /** VLAN id when this is a kmc VPC */
  vlan?: number;
}

export interface ClusterCatalog {
  namespaces: NamespaceInfo[];
  instanceTypes: InstanceTypeInfo[];
  preferences: PreferenceInfo[];
  storageClasses: StorageClassInfo[];
  images: ImageInfo[];
  defaultStorageClass?: string;
  hasInstanceTypes: boolean;
}

export type VmLifecycleIntent =
  "stop" | "start" | "restart" | "softreboot" | "pause" | "unpause" | "delete";

// --- DataVolumes (cdi.kubevirt.io) ---

export interface DataVolumeSummary {
  cluster: ClusterId;
  namespace: string;
  name: string;
  phase: string;
  progress?: string;
  size?: string;
  storageClass?: string;
  sourceKind: string;
  sourceDetail?: string;
  age: string;
  message?: string;
  ownerKind?: string;
  ownerName?: string;
}

export interface DataVolumeDetail extends DataVolumeSummary {
  uid?: string;
  volumeMode?: string;
  accessModes?: string[];
  claimName?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  conditions: VmCondition[];
}

export type DataVolumeSourceKind = "blank" | "pvc" | "http";

export interface CreateDataVolumeRequest {
  cluster: ClusterId;
  namespace: string;
  name: string;
  size: string;
  storageClass?: string;
  volumeMode?: "Block" | "Filesystem";
  source: {
    kind: DataVolumeSourceKind;
    /** pvc clone */
    pvcNamespace?: string;
    pvcName?: string;
    /** http import */
    url?: string;
  };
}

// --- Cluster instance types (instancetype.kubevirt.io) ---

export interface ClusterInstanceTypeSummary {
  cluster: ClusterId;
  name: string;
  cpu: number;
  memory: string;
  age: string;
  /** common-instancetypes class, e.g. general.purpose */
  class?: string;
  /** Size label or name suffix, e.g. medium, xlarge */
  size?: string;
  /** e.g. kubevirt.io when from common-instancetypes */
  vendor?: string;
  /** common-instancetypes package version when labeled */
  commonVersion?: string;
  /**
   * Operator / common-instancetypes provided types are treated as built-in:
   * not editable or deletable via kmc.
   */
  builtin: boolean;
}

export interface ClusterInstanceTypeDetail extends ClusterInstanceTypeSummary {
  uid?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export interface UpsertClusterInstanceTypeRequest {
  cluster: ClusterId;
  name: string;
  cpu: number;
  memory: string;
}

// --- Ingresses (networking.k8s.io) bound to VMs ---

export interface IngressSummary {
  cluster: ClusterId;
  namespace: string;
  name: string;
  hosts: string[];
  className?: string;
  /** Target VM name (same namespace) when bound */
  vmName?: string;
  /** Companion Service name (same as Ingress in v1) */
  serviceName?: string;
  age: string;
  /** First loadBalancer ingress host/IP when present */
  address?: string;
}

export interface IngressRulePath {
  path: string;
  pathType: string;
  serviceName: string;
  servicePort: number | string;
}

export interface IngressRuleInfo {
  host?: string;
  paths: IngressRulePath[];
}

export interface IngressDetail extends IngressSummary {
  uid?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  rules: IngressRuleInfo[];
  tls?: Array<{ hosts: string[]; secretName?: string }>;
  servicePorts?: Array<{
    name?: string;
    port: number;
    targetPort: number | string;
    protocol?: string;
  }>;
  /** Endpoint readiness for the companion Service (when available) */
  endpointsReady?: number;
  endpointsTotal?: number;
  vm?: { name: string; exists: boolean; podNetwork: boolean };
}

export type IngressPathType = "Prefix" | "Exact" | "ImplementationSpecific";

export interface CreateIngressRequest {
  cluster: ClusterId;
  namespace: string;
  name: string;
  vmName: string;
  host: string;
  path?: string;
  pathType?: IngressPathType;
  servicePort?: number;
  targetPort?: number;
  ingressClassName?: string;
}

// --- VPCs (Multus NAD + VLAN from cluster vlanPools) ---

export interface VpcSummary {
  cluster: ClusterId;
  namespace: string;
  name: string;
  vlan: number;
  vlanPoolId?: string;
  bridge?: string;
  /** Present when private IPAM is enabled on the VPC */
  cidr?: string;
  gateway?: string;
  dns?: string[];
  description?: string;
  owner?: string;
  age: string;
}

export interface VpcAttachedVm {
  cluster: ClusterId;
  namespace: string;
  name: string;
  /**
   * Static IPv4 from kmc.ianunruh.com/ipv4 for this VPC attachment
   * (may include /prefix). Multi-attach VMs pick the address in the VPC CIDR.
   */
  allocatedIpv4?: string;
  /** True when this VM is the kmc-managed NAT gateway for the VPC. */
  isNatGateway?: boolean;
}

/**
 * Agent status reported on the NAT policy ConfigMap.
 * `Stale` is derived server-side when Ready/Pending but heartbeat is too old.
 */
export type NatAgentStatus = "Ready" | "Error" | "Unknown" | "Pending" | "Stale";

/**
 * Floating IP lifecycle:
 * - `associated` — public IP mapped to a private target (DNAT/SNAT active)
 * - `held` — public IP reserved for this VPC but not mapped (kept out of the pool)
 */
export type FloatingIpState = "associated" | "held";

/** 1:1 floating public IP mapped through the NAT gateway (or held unmapped). */
export interface FloatingIpAssociation {
  id: string;
  /** Public / float address (no prefix). */
  public: string;
  /** Prefix length on the public Multus NIC (e.g. 27). */
  prefix: number;
  /** Private VPC target address (no prefix). Absent when held. */
  private?: string;
  /** Optional target VM name (same namespace). */
  targetVm?: string;
  state: FloatingIpState;
}

/** Dual-homed (or triple-homed) Ubuntu NAT gateway for a VPC. */
export interface NatGatewayInfo {
  cluster: ClusterId;
  namespace: string;
  name: string;
  /** Private (VPC) address, may include /prefix. */
  privateIpv4?: string;
  /** Public / egress Multus address, may include /prefix. */
  publicIpv4?: string;
  /** Multus NAD used for egress. */
  publicNetwork?: string;
  /** Policy ConfigMap name (floating IPs), if managed. */
  policyConfigMap?: string;
  /** In-guest agent status from policy CM annotations (may be Stale). */
  agentStatus?: NatAgentStatus;
  agentObservedGeneration?: string;
  agentLastError?: string;
  agentAppliedAt?: string;
  /** Last agent liveness heartbeat (ISO-8601). */
  agentHeartbeatAt?: string;
  /** Short hash of the running agent script. */
  agentVersion?: string;
  /** Floating IP associations from the policy ConfigMap. */
  floatingIps?: FloatingIpAssociation[];
}

export interface VpcDetail extends VpcSummary {
  uid?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  attachedVms: VpcAttachedVm[];
  attachedCount: number;
  ipPool?: NetworkIpPoolInfo;
  /** Present when a kmc-managed NAT gateway VM exists for this VPC. */
  natGateway?: NatGatewayInfo;
  /**
   * Floating IP associations from the NAT policy ConfigMap.
   * Present even when the NAT gateway VM is missing (policy survives GW delete).
   */
  floatingIps: FloatingIpAssociation[];
}

/**
 * Launch a NAT gateway VM for a VPC (private Multus + public Multus + pod network).
 * Private IP is pinned to the VPC gateway address; public IP from the chosen pool.
 * Pod NIC is used by the in-guest agent to watch the policy ConfigMap.
 */
export interface CreateNatGatewayRequest {
  cluster: ClusterId;
  namespace: string;
  vpcName: string;
  name: string;
  /** Multus NAD for north-south egress (must have a static ipPools entry). */
  publicMultusNetwork: string;
  sshPublicKey: string;
  instanceType?: string;
  cpuCores?: number;
  memory?: string;
  diskSize: string;
  storageClass?: string;
  image: {
    kind: "pvc";
    namespace: string;
    name: string;
  };
  start?: boolean;
}

/** Associate a floating public IP to a private VPC address via the NAT gateway. */
export interface AssociateFloatingIpRequest {
  cluster: ClusterId;
  namespace: string;
  vpcName: string;
  /** Private target IPv4 (no prefix). Defaults from targetVm IPAM when omitted. */
  privateIpv4?: string;
  /** Target VM name (same namespace); used to resolve private IP when not set. */
  targetVm?: string;
  /** Optional specific public address; otherwise allocate from the public pool. */
  publicIpv4?: string;
}

export interface DisassociateFloatingIpRequest {
  cluster: ClusterId;
  namespace: string;
  vpcName: string;
  /** Floating IP id or public address. */
  idOrPublic: string;
}

/** Release a held (or associated) floating IP back to the public pool. */
export interface ReleaseFloatingIpRequest {
  cluster: ClusterId;
  namespace: string;
  vpcName: string;
  /** Floating IP id or public address. */
  idOrPublic: string;
}

/** Row for the top-level floating IP list (and embed on VPC/VM detail). */
export interface FloatingIpSummary {
  cluster: ClusterId;
  namespace: string;
  vpcName: string;
  id: string;
  public: string;
  prefix: number;
  /** Private target when associated; omitted when held. */
  private?: string;
  targetVm?: string;
  state: FloatingIpState;
  /** NAT gateway VM name when known from the policy CM labels / VPC. */
  natGatewayVm?: string;
  agentStatus?: NatAgentStatus;
  agentHeartbeatAt?: string;
  policyConfigMap?: string;
}

/** VPC that can accept floating IP associations (has NAT gateway + policy). */
export interface FloatingIpEligibleVpc {
  cluster: ClusterId;
  namespace: string;
  name: string;
  cidr?: string;
  natGatewayName?: string;
  publicNetwork?: string;
  agentStatus?: NatAgentStatus;
  floatingCount: number;
  /** Held public addresses available to re-associate without allocating. */
  heldPublicIps: string[];
  /** Non–NAT-gateway attached VMs with private addresses. */
  targetVms: Array<{
    name: string;
    allocatedIpv4?: string;
  }>;
}

export interface CreateVpcRequest {
  cluster: ClusterId;
  namespace: string;
  name: string;
  description?: string;
  /** When set, enables scan-derived IPAM for this VPC NAD */
  cidr?: string;
  gateway?: string;
  dns?: string[];
  /** Prefer a specific vlanPools entry; default = first pool */
  vlanPoolId?: string;
}

/**
 * Mutable VPC fields (name, namespace, VLAN, bridge are immutable).
 * IPAM: set cidr to enable; omit/empty cidr to disable and clear gateway/dns.
 */
export interface UpdateVpcRequest {
  cluster: ClusterId;
  namespace: string;
  name: string;
  description?: string;
  cidr?: string;
  gateway?: string;
  dns?: string[];
}

// --- Network topology (VPCs / Multus NADs ↔ VMs) ---

export type TopologyNetworkKind = "vpc" | "multus" | "pod";

export interface TopologyNetworkNode {
  /** Stable id: `cluster/namespace/name` or `cluster/namespace/__pod__` */
  id: string;
  kind: TopologyNetworkKind;
  cluster: ClusterId;
  namespace: string;
  name: string;
  vlan?: number;
  cidr?: string;
  /** True when a Multus NAD was found for this node (false for orphaned refs). */
  exists?: boolean;
}

export interface TopologyVmNode {
  id: string;
  cluster: ClusterId;
  namespace: string;
  name: string;
  status: string;
  ready: boolean;
  /** Public floating IPs associated with this VM (from NAT policy). */
  floatingIpv4?: string[];
}

export interface TopologyEdge {
  id: string;
  networkId: string;
  vmId: string;
  /** Interface name on the VM template (e.g. default, net1). */
  interfaceName?: string;
  /**
   * `attachment` (default): Multus/pod NIC on the VM.
   * `floating`: 1:1 public→private DNAT via a VPC NAT gateway.
   */
  role?: "attachment" | "floating";
  /** Optional display label (e.g. floating public address). */
  label?: string;
}

export interface NetworkTopology {
  networks: TopologyNetworkNode[];
  vms: TopologyVmNode[];
  edges: TopologyEdge[];
}
