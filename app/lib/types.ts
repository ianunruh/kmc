export type ClusterId = string;

export interface ClusterInfo {
  id: ClusterId;
  reachable: boolean;
  error?: string;
  hasInstanceTypes: boolean;
  defaultStorageClass?: string;
}

export interface VmSummary {
  cluster: ClusterId;
  namespace: string;
  name: string;
  status: string;
  ready: boolean;
  running: boolean;
  cpu?: string;
  memory?: string;
  disk?: string;
  age: string;
  nodeName?: string;
  message?: string;
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
}

export interface VmNetworkInfo {
  name: string;
  model?: string;
  multusNetworkName?: string;
  pod?: boolean;
  mac?: string;
  ipAddresses?: string[];
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
  ipv4Address?: string;
  vmiPhase?: string;
  hasVmi: boolean;
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
  network?: {
    multusNetworkName: string;
  };
  sshPublicKey: string;
  start?: boolean;
}

export interface NamespaceInfo {
  name: string;
}

export interface InstanceTypeInfo {
  name: string;
  cpu?: string;
  memory?: string;
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
}

export interface NetworkInfo {
  name: string;
  namespace: string;
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

export type VmLifecycleIntent = "stop" | "start" | "delete";

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
