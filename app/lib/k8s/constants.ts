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
 * What a kmc-managed backend Service / Ingress is bound to.
 * VirtualMachine | LabelSelector | Group
 */
export const KMC_LABEL_TARGET_KIND = `${KMC_LABEL_NAMESPACE}/target-kind`;
export const KMC_TARGET_KIND_VM = "VirtualMachine";
export const KMC_TARGET_KIND_LABELS = "LabelSelector";
export const KMC_TARGET_KIND_GROUP = "Group";

/**
 * Group id stamped on member VM pod templates and used as Service selector
 * for group membership (`kmc.ianunruh.com/backend-group=<id>`).
 */
export const KMC_LABEL_BACKEND_GROUP = `${KMC_LABEL_NAMESPACE}/backend-group`;

/** JSON object of match labels for LabelSelector membership (Service annotation). */
export const KMC_ANN_MATCH_LABELS = `${KMC_LABEL_NAMESPACE}/match-labels`;

/** Comma-separated VM names in a group (Service annotation; UI convenience). */
export const KMC_ANN_MEMBER_VMS = `${KMC_LABEL_NAMESPACE}/member-vms`;

/** Ingress name stamped on the companion backend Service (1:1 create). */
export const KMC_LABEL_INGRESS = `${KMC_LABEL_NAMESPACE}/ingress`;

/** Labels on kmc-managed resources (VPC NAD, backend Service, etc.). */
export const KMC_LABEL_RESOURCE = `${KMC_LABEL_NAMESPACE}/resource`;

/**
 * Value of kmc.ianunruh.com/resource for kmc-managed backend Services
 * (pod-network VM exposure: ClusterIP today, LoadBalancer later).
 */
export const KMC_RESOURCE_BACKEND = "backend";

/** Value of kmc.ianunruh.com/resource for kmc-managed Ingresses. */
export const KMC_RESOURCE_INGRESS = "ingress";

/** List selector for kmc-managed backend Services. */
export const KMC_BACKEND_LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${KMC_MANAGED_BY},${KMC_LABEL_RESOURCE}=${KMC_RESOURCE_BACKEND}`;

/** List selector for kmc-managed Ingresses (any membership mode). */
export const KMC_INGRESS_LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${KMC_MANAGED_BY},${KMC_LABEL_RESOURCE}=${KMC_RESOURCE_INGRESS}`;

/** Max VMs that can be added to a backend group at create time. */
export const KMC_MAX_BACKEND_GROUP_VMS = 32;

/** Value of kmc.ianunruh.com/resource for CloudNativePG Cluster databases. */
export const KMC_RESOURCE_DATABASE = "database";

/** Size preset stamped on kmc-managed databases (`small` | `medium` | `large`). */
export const KMC_LABEL_SIZE = `${KMC_LABEL_NAMESPACE}/size`;

/** List selector for kmc-managed CNPG Clusters (create path stamps these). */
export const KMC_DATABASE_LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${KMC_MANAGED_BY},${KMC_LABEL_RESOURCE}=${KMC_RESOURCE_DATABASE}`;

/** CloudNativePG Cluster API (postgresql.cnpg.io). */
export const CNPG_GROUP = "postgresql.cnpg.io";
export const CNPG_VERSION = "v1";
export const CNPG_CLUSTER_PLURAL = "clusters";

/** Value of kmc.ianunruh.com/resource for self-service VPC NADs. */
export const KMC_RESOURCE_VPC = "vpc";

/** Value of kmc.ianunruh.com/resource for static/shared Multus NADs (from ipPools). */
export const KMC_RESOURCE_NETWORK = "network";
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

/**
 * Shared router name (same namespace) attached to this VPC.
 * OpenStack-style: one router may attach many VPCs.
 */
export const KMC_ANN_ROUTER = `${KMC_LABEL_NAMESPACE}/router`;

/** VM role labels (e.g. shared router for a VPC). */
export const KMC_LABEL_ROLE = `${KMC_LABEL_NAMESPACE}/role`;
/** Shared router appliance (DHCP/DNS + optional external SNAT / floating IPs). */
export const KMC_ROLE_ROUTER = "router";
/** VPC NAD name (same namespace as the VM) this role serves. */
export const KMC_LABEL_VPC = `${KMC_LABEL_NAMESPACE}/vpc`;
/** Router name label on policy CM / router VM. */
export const KMC_LABEL_ROUTER = `${KMC_LABEL_NAMESPACE}/router`;

/** Value of kmc.ianunruh.com/resource for shared router policy ConfigMaps. */
export const KMC_RESOURCE_ROUTER_POLICY = "router-policy";

/** List selector for kmc-managed VPC NADs. */
export const KMC_VPC_LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${KMC_MANAGED_BY},${KMC_LABEL_RESOURCE}=${KMC_RESOURCE_VPC}`;

/** List selector for shared router policy ConfigMaps. */
export const KMC_ROUTER_POLICY_LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${KMC_MANAGED_BY},${KMC_LABEL_RESOURCE}=${KMC_RESOURCE_ROUTER_POLICY}`;

/** Router policy ConfigMap data key (JSON RouterPolicy). */
export const KMC_ROUTER_POLICY_DATA_KEY = "policy.json";

/** Router policy ConfigMap data key for the in-guest agent source. */
export const KMC_ROUTER_AGENT_SCRIPT_KEY = "agent.py";

/**
 * Max Multus NICs on a single VM (kmc createVm limit).
 * Router: N VPC interfaces + optional external ≤ this.
 */
export const KMC_MAX_MULTUS_ATTACHMENTS = 8;

/**
 * Max secondary (non-root, non-cloudinit) data disks on a single VM.
 * Applies to create-time extras and Storage-tab attach.
 */
export const KMC_MAX_EXTRA_DISKS = 8;

/** Reserved volume/disk names that cannot be used for secondary disks. */
export const KMC_RESERVED_VOLUME_NAMES = ["root", "cloudinit"] as const;

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
export const KMC_AGENT_STALE_AFTER_MS = 90_000;

/**
 * Comma-separated floating public IPv4s held by a router external NIC (IPAM scan).
 * May include /prefix; used so secondary floats are not double-allocated.
 */
export const KMC_ANN_FLOATING_IPV4 = `${KMC_LABEL_NAMESPACE}/floating-ipv4`;

/**
 * DataVolume retained after VM delete (value = former VirtualMachine name).
 * Applied when deleteVm({ retainDisks: true }) strips ownerReferences.
 */
export const KMC_LABEL_RETAINED_FROM_VM = `${KMC_LABEL_NAMESPACE}/retained-from-vm`;

/** ISO timestamp when a DataVolume was retained from a VM delete. */
export const KMC_ANN_RETAINED_AT = `${KMC_LABEL_NAMESPACE}/retained-at`;

/**
 * CDI DataVolume `status.phase` values allowed for create-from-existing root disk.
 * "Ready" is a condition type, not a phase — do not list it here.
 */
export const REUSABLE_DV_PHASES = ["Succeeded"] as const;

/**
 * Root disk size stamped on the VirtualMachine (e.g. `100Gi`).
 * Used when the VM has no dataVolumeTemplates (standalone root DataVolume).
 */
export const KMC_ANN_DISK_SIZE = `${KMC_LABEL_NAMESPACE}/disk-size`;

/** Value of kmc.ianunruh.com/resource for VirtualMachineSnapshot objects. */
export const KMC_RESOURCE_VM_SNAPSHOT = "vm-snapshot";

/**
 * Value of kmc.ianunruh.com/resource for per-VM snapshot schedule ConfigMaps
 * (policy + CronJob companion objects).
 */
export const KMC_RESOURCE_VM_SNAPSHOT_SCHEDULE = "vm-snapshot-schedule";

/**
 * Schedule ConfigMap name stamped on scheduled VirtualMachineSnapshots so
 * retention prune only touches snaps from that schedule.
 */
export const KMC_LABEL_SCHEDULE = `${KMC_LABEL_NAMESPACE}/schedule`;

/** `manual` | `scheduled` — how the snapshot was created. */
export const KMC_LABEL_SNAPSHOT_KIND = `${KMC_LABEL_NAMESPACE}/snapshot-kind`;
export const KMC_SNAPSHOT_KIND_MANUAL = "manual";
export const KMC_SNAPSHOT_KIND_SCHEDULED = "scheduled";

/** Schedule policy JSON key in the schedule ConfigMap. */
export const KMC_SNAPSHOT_SCHEDULE_DATA_KEY = "schedule.json";

/** Status annotations written by the CronJob runner on the schedule ConfigMap. */
export const KMC_ANN_SCHEDULE_LAST_RUN_AT = `${KMC_LABEL_NAMESPACE}/last-run-at`;
export const KMC_ANN_SCHEDULE_LAST_SUCCESS_AT = `${KMC_LABEL_NAMESPACE}/last-success-at`;
export const KMC_ANN_SCHEDULE_LAST_SNAPSHOT = `${KMC_LABEL_NAMESPACE}/last-snapshot`;
export const KMC_ANN_SCHEDULE_LAST_ERROR = `${KMC_LABEL_NAMESPACE}/last-error`;
/** Snapshot names deleted during the last prune (comma-separated, truncated). */
export const KMC_ANN_SCHEDULE_LAST_PRUNED = `${KMC_LABEL_NAMESPACE}/last-pruned`;

/** List selector for kmc-managed snapshot schedule ConfigMaps. */
export const KMC_SNAPSHOT_SCHEDULE_LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${KMC_MANAGED_BY},${KMC_LABEL_RESOURCE}=${KMC_RESOURCE_VM_SNAPSHOT_SCHEDULE}`;

/**
 * Value of kmc.ianunruh.com/resource for golden images imported via kmc
 * (DataVolumes in the image namespace). Virtctl-uploaded images may omit this.
 */
export const KMC_RESOURCE_IMAGE = "image";

/**
 * Value of kmc.ianunruh.com/resource for the per-namespace ResourceQuota that
 * kmc creates/updates for project capacity limits.
 */
export const KMC_RESOURCE_NAMESPACE_QUOTA = "namespace-quota";

/**
 * Fixed name for the kmc-managed ResourceQuota in each vm-allowed namespace.
 * One object keeps create/edit/capacity visualization simple.
 */
export const KMC_NAMESPACE_QUOTA_NAME = "kmc-quota";
