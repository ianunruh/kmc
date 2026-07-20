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
