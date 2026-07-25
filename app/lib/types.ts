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
  /** Public floating IPs associated with this VM (from router policy ConfigMaps). */
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
  /** True when this is the boot disk (`root`). */
  isRoot?: boolean;
  /**
   * DataVolume / PVC volume marked hotpluggable (detach via removevolume).
   * Create-time secondaries and hotplugged disks set this.
   */
  hotpluggable?: boolean;
  /** Live hotplug phase from VMI status.volumeStatus when the VM is running. */
  volumePhase?: string;
  /** True when the UI may offer Detach (DataVolume-backed secondary disk). */
  canDetach?: boolean;
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

/** How createVm obtains the root disk. Default is golden-image clone. */
export type CreateVmDiskSourceMode = "image" | "existingDataVolume";

export interface CreateVmRequest {
  cluster: ClusterId;
  namespace: string;
  name: string;
  instanceType?: string;
  cpuCores?: number;
  memory?: string;
  preference?: string;
  /** Required when diskSource is "image" (default). */
  diskSize?: string;
  storageClass?: string;
  /** Required when diskSource is "image" (default). */
  image?: {
    kind: "pvc";
    namespace: string;
    name: string;
  };
  /**
   * Default "image". When "existingDataVolume", set existingDataVolumeName
   * and omit clone fields (diskSize / image).
   */
  diskSource?: CreateVmDiskSourceMode;
  /**
   * Name of an existing DataVolume in the same namespace as the VM.
   * Required when diskSource === "existingDataVolume".
   * Volume ref uses this name (may differ from the new VM name).
   */
  existingDataVolumeName?: string;
  /**
   * Multus network attachments in order (first is primary for default route when IPAM applies).
   * Empty / omit → pod network only.
   */
  networks?: Array<{
    multusNetworkName: string;
  }>;
  /**
   * When Multus attachments are present, also attach the pod network (masquerade)
   * as the first interface so KubeVirt port-forward / browser Terminal can reach
   * the guest. Default true when Multus is used; set false to Multus-only.
   * Ignored when networks is empty (pod-only VMs).
   */
  includePodNetwork?: boolean;
  sshPublicKey: string;
  start?: boolean;
  /**
   * When true, cloud-init installs and enables qemu-guest-agent (soft reboot,
   * guest OS info). Requires guest package repos on first boot.
   */
  installGuestAgent?: boolean;
  /**
   * Optional secondary data disks (standalone DataVolumes, scsi bus).
   * Root remains the primary boot disk; these are hotpluggable for later detach.
   */
  extraDisks?: CreateVmExtraDisk[];
}

/** How a secondary disk obtains its backing DataVolume. */
export type VmDiskSourceMode = "blank" | "existingDataVolume";

/** Extra disk requested at VM create time. */
export interface CreateVmExtraDisk {
  /** Volume + disk device name; optional → server assigns disk-N. */
  name?: string;
  /** Default blank. existingDataVolume requires existingDataVolumeName. */
  source?: VmDiskSourceMode;
  /** Required when source is blank (default). */
  size?: string;
  storageClass?: string;
  /** Required when source is existingDataVolume. */
  existingDataVolumeName?: string;
}

/** Attach a secondary disk to a running or stopped VM (persistent). */
export interface AttachVmDiskRequest {
  cluster: ClusterId;
  namespace: string;
  vmName: string;
  /** Optional volume name; server default disk-N. */
  name?: string;
  source: VmDiskSourceMode;
  /** Required when source is blank. */
  size?: string;
  storageClass?: string;
  /** Required when source is existingDataVolume. */
  existingDataVolumeName?: string;
}

export interface AttachVmDiskResult {
  volumeName: string;
  dataVolumeName: string;
  /** True when a new blank DataVolume was created for this attach. */
  createdDataVolume: boolean;
}

/** Detach a secondary disk from a VM. */
export interface DetachVmDiskRequest {
  cluster: ClusterId;
  namespace: string;
  vmName: string;
  /** Volume name on the VM (not necessarily the DataVolume name). */
  volumeName: string;
  /** When true, delete the DataVolume after detach. Default false (keep / retain). */
  deleteDisk?: boolean;
}

export interface DetachVmDiskResult {
  volumeName: string;
  dataVolumeName?: string;
  deletedDataVolume: boolean;
  retainedDataVolume: boolean;
}

/** Resolve create disk mode; default image for routers and legacy callers. */
export function createVmDiskSource(
  input: Pick<CreateVmRequest, "diskSource">,
): CreateVmDiskSourceMode {
  return input.diskSource === "existingDataVolume"
    ? "existingDataVolume"
    : "image";
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

/** Bulk lifecycle intents on the VM list (home action). */
export type VmBulkLifecycleIntent = "bulk-start" | "bulk-stop" | "bulk-delete";

/** One target in a bulk action (namespaced cluster resource). */
export interface BulkResourceTarget {
  cluster: string;
  namespace: string;
  name: string;
}

/** Cluster-scoped resource (namespace list, instance types). */
export interface BulkClusterTarget {
  cluster: string;
  name: string;
}

export type BulkItemStatus = "ok" | "skipped" | "failed";

/** Per-item outcome from a bulk route action. */
export interface BulkItemResult {
  /** Display identity, e.g. cluster/namespace/name or key id. */
  key: string;
  status: BulkItemStatus;
  error?: string;
  retainedDisks?: string[];
}

export interface BulkActionSummary {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

/** Structured result from a bulk route action (partial success is normal). */
export interface BulkActionResult {
  ok: boolean;
  intent: string;
  summary: BulkActionSummary;
  results: BulkItemResult[];
  retainDisks?: boolean;
  /** Top-level error when the bulk request itself is invalid (empty targets, etc.). */
  error?: string;
}

// --- VM snapshots / restores (snapshot.kubevirt.io/v1beta1) ---

/** KubeVirt VirtualMachineSnapshot projected for list/detail UI. */
export interface VmSnapshotSummary {
  cluster: ClusterId;
  namespace: string;
  name: string;
  /** Source VirtualMachine name from spec.source.name */
  vmName: string;
  phase: string;
  readyToUse: boolean;
  /** Online, GuestAgent, NoGuestAgent, QuiesceFailed, … */
  indications: string[];
  age: string;
  error?: string;
  /** VirtualMachineSnapshotContent name when bound */
  contentName?: string;
}

export interface CreateVmSnapshotRequest {
  cluster: ClusterId;
  namespace: string;
  vmName: string;
  /** Optional; default `{vm}-{yyyyMMdd-HHmmss}` sanitized to DNS label. */
  name?: string;
  /** Optional failure deadline duration string (e.g. `5m`). */
  failureDeadline?: string;
}

export interface CreateVmRestoreRequest {
  cluster: ClusterId;
  namespace: string;
  vmName: string;
  snapshotName: string;
  /** Optional; default `restore-{vm}-{yyyyMMdd-HHmmss}`. */
  name?: string;
}

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
  /**
   * Former VirtualMachine name when this DV was retained on VM delete
   * (`kmc.ianunruh.com/retained-from-vm` label).
   */
  retainedFromVm?: string;
}

export interface DataVolumeDetail extends DataVolumeSummary {
  uid?: string;
  volumeMode?: string;
  accessModes?: string[];
  claimName?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  conditions: VmCondition[];
  /**
   * VirtualMachines in the same namespace that currently reference this DV
   * (or its backing PVC) as a volume — backref for standalone root disks.
   */
  attachedVms?: string[];
}

export type DataVolumeSourceKind = "blank" | "pvc" | "http";

export interface CreateDataVolumeRequest {
  cluster: ClusterId;
  namespace: string;
  name: string;
  size: string;
  storageClass?: string;
  volumeMode?: "Block" | "Filesystem";
  /** Extra labels merged onto the DataVolume (e.g. kubevirt.io/vm). */
  labels?: Record<string, string>;
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
  /**
   * Hosts covered by Ingress TLS (use https for these).
   * When a TLS block has no hosts listed, every rule host is included.
   */
  tlsHosts: string[];
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
  /** True when this VM is the shared router for the VPC. */
  isRouter?: boolean;
}

/**
 * Agent status reported on the router policy ConfigMap.
 * `Stale` is derived server-side when Ready/Pending but heartbeat is too old.
 */
export type RouterAgentStatus =
  | "Ready"
  | "Error"
  | "Unknown"
  | "Pending"
  | "Stale";

/**
 * Floating IP lifecycle:
 * - `associated` — public IP mapped to a private target (DNAT/SNAT active)
 * - `held` — public IP reserved for this VPC but not mapped (kept out of the pool)
 */
export type FloatingIpState = "associated" | "held";

/** 1:1 floating public IP mapped through a router external gateway (or held unmapped). */
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

export interface VpcDetail extends VpcSummary {
  uid?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  attachedVms: VpcAttachedVm[];
  attachedCount: number;
  ipPool?: NetworkIpPoolInfo;
  /**
   * Shared router attached to this VPC (OpenStack-style; may serve other VPCs too).
   */
  router?: RouterSummary;
  /**
   * Floating IP associations from the router policy ConfigMap for this VPC.
   */
  floatingIps: FloatingIpAssociation[];
}

/** DHCP lease published to the router agent (static dhcp-host). */
export interface RouterLease {
  vpc: string;
  mac: string;
  /** IPv4 without prefix. */
  ip: string;
  hostname: string;
  /** Workload VM name when known. */
  vm?: string;
}

/** One VPC (subnet) interface on a shared router. */
export interface RouterInterfaceInfo {
  vpc: string;
  cidr: string;
  gateway: string;
  mac?: string;
  domain?: string;
  dhcpEnabled?: boolean;
  leaseCount?: number;
}

/** Optional public Multus external gateway (Phase 2+). */
export interface RouterExternalInfo {
  multusNetwork: string;
  primaryCidr?: string;
  gateway?: string;
  snat?: boolean;
}

export interface RouterSummary {
  cluster: ClusterId;
  namespace: string;
  name: string;
  /** VPC names this router attaches to. */
  vpcNames: string[];
  /** True when an external (public) Multus gateway is configured. */
  hasExternal: boolean;
  agentStatus?: RouterAgentStatus;
  agentHeartbeatAt?: string;
  age: string;
}

export interface RouterDetail extends RouterSummary {
  uid?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  policyConfigMap: string;
  interfaces: RouterInterfaceInfo[];
  external?: RouterExternalInfo;
  leases: RouterLease[];
  floatingIps: FloatingIpAssociation[];
  agentObservedGeneration?: string;
  agentLastError?: string;
  agentAppliedAt?: string;
  agentVersion?: string;
  /** Router appliance VM name (same namespace). */
  vmName: string;
  vmStatus?: string;
  vmReady?: boolean;
  /** True when the policy ConfigMap exists but the appliance VirtualMachine does not. */
  vmMissing?: boolean;
}

/**
 * Create a shared router attached to at least one VPC (DHCP/DNS on each).
 * Optional external Multus enables SNAT + floating IPs.
 */
export interface CreateRouterRequest {
  cluster: ClusterId;
  namespace: string;
  name: string;
  /** VPC NAD names in the same namespace (v1 create requires ≥1). */
  vpcNames: string[];
  /** Optional public Multus for external gateway (SNAT + floating IPs). */
  externalMultusNetwork?: string;
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

export interface SetRouterExternalGatewayRequest {
  cluster: ClusterId;
  namespace: string;
  routerName: string;
  publicMultusNetwork: string;
  sshPublicKey: string;
}

/** Associate a floating public IP to a private VPC address via a router external gateway. */
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
  /** Shared router that owns this floating IP (policy + appliance). */
  routerName?: string;
  agentStatus?: RouterAgentStatus;
  agentHeartbeatAt?: string;
  policyConfigMap?: string;
}

/** VPC that can accept floating IP associations (router with external gateway). */
export interface FloatingIpEligibleVpc {
  cluster: ClusterId;
  namespace: string;
  name: string;
  cidr?: string;
  routerName?: string;
  publicNetwork?: string;
  agentStatus?: RouterAgentStatus;
  floatingCount: number;
  /** Held public addresses available to re-associate without allocating. */
  heldPublicIps: string[];
  /** Non-router attached VMs with private addresses. */
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

export type TopologyNetworkKind = "vpc" | "multus" | "pod" | "ingress";

export interface TopologyNetworkNode {
  /** Stable id: `cluster/namespace/name`, `…/__pod__`, or `…/__ingress__` */
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
  /** Public floating IPs associated with this VM (from router policy). */
  floatingIpv4?: string[];
  /** Ingress hostnames bound to this VM (kmc-managed Ingress via pod network). */
  ingressHosts?: string[];
}

export interface TopologyEdge {
  id: string;
  networkId: string;
  vmId: string;
  /** Interface name on the VM template (e.g. default, net1). */
  interfaceName?: string;
  /**
   * `attachment` (default): Multus/pod NIC on the VM.
   * `floating`: 1:1 public→private DNAT via a router external gateway.
   * `ingress`: HTTP(S) exposure via Ingress on the pod network.
   */
  role?: "attachment" | "floating" | "ingress";
  /** Optional display label (e.g. floating public address, ingress host). */
  label?: string;
}

export interface NetworkTopology {
  networks: TopologyNetworkNode[];
  vms: TopologyVmNode[];
  edges: TopologyEdge[];
}
