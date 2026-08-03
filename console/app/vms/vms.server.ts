import { formatError } from "~/lib/errors";
import { canEditVmSpec } from "~/lib/format";
import type {
  AttachVmDiskRequest,
  AttachVmDiskResult,
  ClusterId,
  ClusterInfo,
  CreateVmExtraDisk,
  CreateVmRequest,
  DetachVmDiskRequest,
  DetachVmDiskResult,
  UpdateVmRequest,
  VmDetail,
  VmDiskSourceMode,
  VmGuestAgentInfo,
  VmGuestFilesystem,
  VmNetworkInfo,
  VmSummary,
  VmVolumeInfo,
} from "~/lib/types";
import { createVmDiskSource, VM_RUN_STRATEGIES } from "~/lib/types";
import {
  getClusterClients,
  getConfiguredContexts,
  httpErrorMessage,
  k8sFetch,
} from "~/lib/k8s/clients.server";
import type { KubeConfig } from "@kubernetes/client-node";
import { assertVmNamespaceAllowed } from "~/lib/k8s/catalog.server";
import {
  clusterNetworkCidrList,
  getClusterNetwork,
} from "~/lib/k8s/cluster-config.server";
import { ensureStaticMultusNads } from "~/lib/k8s/static-nads.server";
import {
  allocateIpv4ForMultus,
  dhcpDeferredMultusAllocation,
  generateLocalMacAddress,
  parseMultusNetworkRef,
  parseIpv4AnnotationList,
  type AllocatedIp,
} from "~/lib/ipam/pools.server";
import { IPAM_ANNOTATION_IPV4 } from "~/lib/ipam/constants";
import {
  deleteIpAddressClaimsForVm,
  releaseIpAddressClaims,
} from "~/lib/ipam/ipaddress-cr.server";
import { getPlatformConsolePublicKey } from "~/vms/console-ssh-key.server";
import {
  KMC_ANN_DISK_SIZE,
  KMC_ANN_RETAINED_AT,
  KMC_BACKEND_LABEL_SELECTOR,
  KMC_INGRESS_LABEL_SELECTOR,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_RETAINED_FROM_VM,
  KMC_LABEL_TARGET_KIND,
  KMC_LABEL_VM,
  KMC_LABEL_VLAN,
  KMC_MANAGED_BY,
  KMC_MAX_EXTRA_DISKS,
  KMC_RESERVED_VOLUME_NAMES,
  KMC_RESOURCE_NETWORK,
  KMC_RESOURCE_VPC,
  KMC_TARGET_KIND_VM,
  MANAGED_BY_LABEL,
  REUSABLE_DV_PHASES,
} from "~/lib/k8s/constants";
import { DNS1123_LABEL } from "~/lib/format";
import { addressFromIpv4Annotation } from "~/lib/ipam/cidr";
import {
  getNamespacedCustomObject,
  PLURAL_VPCS,
  type VpcCr,
} from "~/lib/k8s/networking-cr.server";
import { listFloatingIps } from "~/vpcs/vpcs.server";
import {
  bindAllocationsToNetworks,
  buildVirtualMachineManifest,
  multusNetworksFromRequest,
  type ResolvedExtraDisk,
} from "./template.server";

interface KubeVm {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    resourceVersion?: string;
  };
  spec?: {
    running?: boolean;
    runStrategy?: string;
    instancetype?: { name?: string; kind?: string; revisionName?: string };
    preference?: { name?: string; kind?: string; revisionName?: string };
    dataVolumeTemplates?: Array<{
      metadata?: { name?: string };
      spec?: {
        source?: {
          pvc?: { name?: string; namespace?: string };
          http?: { url?: string };
          blank?: unknown;
        };
        pvc?: {
          resources?: { requests?: { storage?: string } };
          storageClassName?: string;
        };
        storage?: {
          resources?: { requests?: { storage?: string } };
          storageClassName?: string;
        };
      };
    }>;
    template?: {
      spec?: {
        architecture?: string;
        domain?: {
          cpu?: { cores?: number; threads?: number; sockets?: number };
          machine?: { type?: string };
          resources?: {
            requests?: { memory?: string; cpu?: string };
            limits?: { memory?: string; cpu?: string };
          };
          devices?: {
            disks?: Array<{
              name?: string;
              disk?: { bus?: string };
              cdrom?: { bus?: string };
            }>;
            interfaces?: Array<{
              name?: string;
              bridge?: unknown;
              masquerade?: unknown;
              model?: string;
              macAddress?: string;
            }>;
          };
        };
        networks?: Array<{
          name?: string;
          pod?: unknown;
          multus?: { networkName?: string };
        }>;
        volumes?: Array<{
          name?: string;
          dataVolume?: { name?: string; hotpluggable?: boolean };
          persistentVolumeClaim?: {
            claimName?: string;
            hotpluggable?: boolean;
          };
          cloudInitNoCloud?: {
            userData?: string;
            networkData?: string;
          };
          containerDisk?: { image?: string };
        }>;
        nodeSelector?: Record<string, string>;
      };
    };
  };
  status?: {
    printableStatus?: string;
    ready?: boolean;
    created?: boolean;
    conditions?: Array<{
      type?: string;
      status?: string;
      message?: string;
      reason?: string;
      lastTransitionTime?: string;
    }>;
    nodeName?: string;
    instancetypeRef?: { name?: string; kind?: string };
  };
}

interface KubeVmi {
  status?: {
    phase?: string;
    nodeName?: string;
    guestOSInfo?: {
      name?: string;
      prettyName?: string;
      version?: string;
      versionId?: string;
      kernelRelease?: string;
      kernelVersion?: string;
      machine?: string;
      id?: string;
    };
    interfaces?: Array<{
      name?: string;
      mac?: string;
      ipAddress?: string;
      ipAddresses?: string[];
      /** Guest-side NIC name from the agent (e.g. enp1s0). */
      interfaceName?: string;
      linkState?: string;
    }>;
    conditions?: Array<{
      type?: string;
      status?: string;
      message?: string;
      reason?: string;
      lastTransitionTime?: string;
    }>;
    /** Hotplug / volume readiness (name matches template volume name). */
    volumeStatus?: Array<{
      name?: string;
      phase?: string;
      reason?: string;
      message?: string;
      target?: string;
      hotplugVolume?: unknown;
    }>;
  };
}

const RESERVED_VOLUME_NAME_SET = new Set<string>(KMC_RESERVED_VOLUME_NAMES);

function mapVm(
  cluster: ClusterId,
  vm: KubeVm,
  instanceTypes?: Map<string, InstanceTypeSize>,
): VmSummary {
  const name = vm.metadata?.name ?? "unknown";
  const namespace = vm.metadata?.namespace ?? "default";
  const status = vm.status?.printableStatus ?? "Unknown";
  const readyCondition = vm.status?.conditions?.find((c) => c.type === "Ready");
  const ready =
    vm.status?.ready === true ||
    readyCondition?.status === "True" ||
    status === "Running";

  const runningStatuses = new Set([
    "Running",
    "Starting",
    "Migrating",
    "Paused",
    "Provisioning",
    "WaitingForVolumeBinding",
  ]);
  const running = runningStatuses.has(status);

  // Prefer live matcher, then status ref / common labels set by the controller.
  const instanceType =
    vm.spec?.instancetype?.name ||
    vm.status?.instancetypeRef?.name ||
    vm.metadata?.labels?.["instancetype.kubevirt.io/cluster-instancetype-name"] ||
    vm.metadata?.labels?.["instancetype.kubevirt.io/instancetype-name"] ||
    undefined;
  let cores = vm.spec?.template?.spec?.domain?.cpu?.cores;
  let memory =
    vm.spec?.template?.spec?.domain?.resources?.requests?.memory ??
    vm.spec?.template?.spec?.domain?.resources?.limits?.memory;

  // Instance-type VMs usually omit inline domain resources; resolve guest size
  // from the cluster instance type when available.
  if (instanceType && instanceTypes?.has(instanceType)) {
    const it = instanceTypes.get(instanceType)!;
    if (cores == null && it.cpu != null && it.cpu !== "") {
      const n = Number(it.cpu);
      cores = Number.isFinite(n) ? n : undefined;
    }
    if (!memory && it.memory) {
      memory = it.memory;
    }
  }

  const tpl = vm.spec?.dataVolumeTemplates?.[0];
  const diskFromTemplate =
    tpl?.spec?.storage?.resources?.requests?.storage ??
    tpl?.spec?.pvc?.resources?.requests?.storage;
  const diskFromAnn = vm.metadata?.annotations?.[KMC_ANN_DISK_SIZE]?.trim();
  const disk = diskFromTemplate ?? (diskFromAnn || undefined);
  let diskDataVolume = tpl?.metadata?.name || undefined;

  if (!diskDataVolume) {
    const volumes = vm.spec?.template?.spec?.volumes ?? [];
    const rootVol = volumes.find((v) => v.name === "root" && v.dataVolume?.name);
    diskDataVolume =
      rootVol?.dataVolume?.name ??
      volumes.find((v) => v.dataVolume?.name)?.dataVolume?.name;
  }

  const notReady = vm.status?.conditions?.find(
    (c) => c.type === "Ready" && c.status !== "True",
  );
  const restartRequiredCond = vm.status?.conditions?.find(
    (c) => c.type === "RestartRequired" && c.status === "True",
  );

  const allocatedIpv4 = vm.metadata?.annotations?.[IPAM_ANNOTATION_IPV4];

  return {
    cluster,
    namespace,
    name,
    status,
    ready,
    running,
    cpu: cores != null ? `${cores}c` : undefined,
    memory,
    instanceType,
    disk,
    diskDataVolume,
    allocatedIpv4: allocatedIpv4 || undefined,
    age: vm.metadata?.creationTimestamp ?? "",
    nodeName: vm.status?.nodeName,
    message: notReady?.message ?? notReady?.reason,
    restartRequired: restartRequiredCond != null,
    restartRequiredMessage:
      restartRequiredCond?.message ?? restartRequiredCond?.reason,
  };
}

type InstanceTypeSize = { cpu?: string; memory?: string };

async function loadInstanceTypeSizes(
  cluster: ClusterId,
): Promise<Map<string, InstanceTypeSize>> {
  try {
    const { custom } = getClusterClients(cluster);
    const res = (await custom.listClusterCustomObject({
      group: "instancetype.kubevirt.io",
      version: "v1beta1",
      plural: "virtualmachineclusterinstancetypes",
    })) as {
      items?: Array<{
        metadata?: { name?: string };
        spec?: {
          cpu?: { guest?: number };
          memory?: { guest?: string };
        };
      }>;
    };
    const map = new Map<string, InstanceTypeSize>();
    for (const item of res.items ?? []) {
      const name = item.metadata?.name;
      if (!name) continue;
      map.set(name, {
        cpu: item.spec?.cpu?.guest != null ? String(item.spec.cpu.guest) : undefined,
        memory: item.spec?.memory?.guest,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

type DataVolumeDiskInfo = {
  size?: string;
  storageClass?: string;
  /** Short source description for volume detail. */
  sourceDetail?: string;
};

function dataVolumeDiskInfo(dv: {
  spec?: {
    storage?: {
      storageClassName?: string;
      resources?: { requests?: { storage?: string } };
    };
    pvc?: {
      storageClassName?: string;
      resources?: { requests?: { storage?: string } };
    };
    source?: {
      pvc?: { name?: string; namespace?: string };
      http?: { url?: string };
      blank?: unknown;
    };
  };
}): DataVolumeDiskInfo {
  const size =
    dv.spec?.storage?.resources?.requests?.storage ??
    dv.spec?.pvc?.resources?.requests?.storage;
  const storageClass =
    dv.spec?.storage?.storageClassName ?? dv.spec?.pvc?.storageClassName;
  const src = dv.spec?.source;
  let sourceDetail: string | undefined;
  if (src?.pvc?.name) {
    sourceDetail = `clone ${src.pvc.namespace ?? "?"}/${src.pvc.name}`;
  } else if (src?.http?.url) {
    sourceDetail = `http ${src.http.url}`;
  } else if (src?.blank != null) {
    sourceDetail = "blank";
  }
  return { size, storageClass, sourceDetail };
}

/** Cluster-wide index: `namespace/name` → disk info. */
async function loadClusterDataVolumeDiskIndex(
  cluster: ClusterId,
): Promise<Map<string, DataVolumeDiskInfo>> {
  const map = new Map<string, DataVolumeDiskInfo>();
  try {
    const { custom } = getClusterClients(cluster);
    const res = (await custom.listClusterCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      plural: "datavolumes",
    })) as {
      items?: Array<{
        metadata?: { name?: string; namespace?: string };
        spec?: DataVolumeDiskInfo extends never ? never : {
          storage?: {
            storageClassName?: string;
            resources?: { requests?: { storage?: string } };
          };
          pvc?: {
            storageClassName?: string;
            resources?: { requests?: { storage?: string } };
          };
          source?: {
            pvc?: { name?: string; namespace?: string };
            http?: { url?: string };
            blank?: unknown;
          };
        };
      }>;
    };
    for (const dv of res.items ?? []) {
      const ns = dv.metadata?.namespace;
      const n = dv.metadata?.name;
      if (!ns || !n) continue;
      map.set(`${ns}/${n}`, dataVolumeDiskInfo(dv));
    }
  } catch {
    /* best-effort enrichment */
  }
  return map;
}

function mapVolumes(
  vm: KubeVm,
  dvIndex?: Map<string, DataVolumeDiskInfo>,
  vmi?: KubeVmi | null,
): VmVolumeInfo[] {
  const disks = vm.spec?.template?.spec?.domain?.devices?.disks ?? [];
  const diskByName = new Map(disks.map((d) => [d.name ?? "", d] as const));
  const dvTemplates = new Map(
    (vm.spec?.dataVolumeTemplates ?? []).map((dv) => [dv.metadata?.name ?? "", dv]),
  );
  const namespace = vm.metadata?.namespace ?? "default";
  const phaseByName = new Map(
    (vmi?.status?.volumeStatus ?? [])
      .filter((vs) => vs.name)
      .map((vs) => [vs.name!, vs.phase ?? ""] as const),
  );

  return (vm.spec?.template?.spec?.volumes ?? []).map((vol) => {
    const volName = vol.name ?? "";
    const disk = diskByName.get(volName);
    const bus = disk?.disk?.bus ?? disk?.cdrom?.bus;
    const volumePhase = phaseByName.get(volName) || undefined;
    const isRoot = volName === "root";

    if (vol.dataVolume?.name) {
      const tpl = dvTemplates.get(vol.dataVolume.name);
      let size =
        tpl?.spec?.storage?.resources?.requests?.storage ??
        tpl?.spec?.pvc?.resources?.requests?.storage;
      let storageClass =
        tpl?.spec?.storage?.storageClassName ?? tpl?.spec?.pvc?.storageClassName;
      let src = tpl?.spec?.source?.pvc
        ? `clone ${tpl.spec.source.pvc.namespace}/${tpl.spec.source.pvc.name}`
        : tpl?.spec?.source?.http?.url
          ? `http ${tpl.spec.source.http.url}`
          : tpl?.spec?.source?.blank
            ? "blank"
            : undefined;
      if ((!size || !src) && dvIndex) {
        const info = dvIndex.get(`${namespace}/${vol.dataVolume.name}`);
        if (info) {
          size = size ?? info.size;
          storageClass = storageClass ?? info.storageClass;
          src = src ?? info.sourceDetail;
        }
      }
      // Root disk size annotation when DV index unavailable
      if (!size && isRoot) {
        size = vm.metadata?.annotations?.[KMC_ANN_DISK_SIZE]?.trim() || undefined;
      }
      const hotpluggable = vol.dataVolume.hotpluggable === true;
      const canDetach =
        !RESERVED_VOLUME_NAME_SET.has(volName) && Boolean(vol.dataVolume.name);
      return {
        name: volName,
        kind: "DataVolume",
        detail: src ?? vol.dataVolume.name,
        diskBus: bus,
        size,
        storageClass,
        linkName: vol.dataVolume.name,
        isRoot,
        hotpluggable,
        volumePhase,
        canDetach,
      };
    }
    if (vol.persistentVolumeClaim?.claimName) {
      const hotpluggable = vol.persistentVolumeClaim.hotpluggable === true;
      return {
        name: volName,
        kind: "PVC",
        detail: vol.persistentVolumeClaim.claimName,
        diskBus: bus,
        // CDI often backs a DV of the same name; link to DV detail when possible.
        linkName: vol.persistentVolumeClaim.claimName,
        isRoot,
        hotpluggable,
        volumePhase,
        canDetach: false,
      };
    }
    if (vol.cloudInitNoCloud) {
      return {
        name: volName,
        kind: "cloudInitNoCloud",
        detail: vol.cloudInitNoCloud.networkData ? "userData + networkData" : "userData",
        diskBus: bus,
        isRoot,
        volumePhase,
        canDetach: false,
      };
    }
    if (vol.containerDisk?.image) {
      return {
        name: volName,
        kind: "containerDisk",
        detail: vol.containerDisk.image,
        diskBus: bus,
        isRoot,
        volumePhase,
        canDetach: false,
      };
    }
    return {
      name: volName || "unknown",
      kind: "other",
      diskBus: bus,
      isRoot,
      volumePhase,
      canDetach: false,
    };
  });
}

/** Drop IPv6 link-local (fe80::/10) from guest/VMI address lists for display. */
function isLinkLocalIpv6(ip: string): boolean {
  const bare = ip.trim().split("%")[0]?.toLowerCase() ?? "";
  return bare.startsWith("fe80:");
}

function filterDisplayIps(ips: string[] | undefined): string[] | undefined {
  if (!ips?.length) return undefined;
  const filtered = ips.filter((ip) => ip.trim() && !isLinkLocalIpv6(ip));
  return filtered.length > 0 ? filtered : undefined;
}

function mapNetworks(vm: KubeVm, vmi?: KubeVmi | null): VmNetworkInfo[] {
  const networks = vm.spec?.template?.spec?.networks ?? [];
  const ifaces = vm.spec?.template?.spec?.domain?.devices?.interfaces ?? [];
  const ifaceByName = new Map(ifaces.map((i) => [i.name ?? "", i] as const));
  const statusByName = new Map(
    (vmi?.status?.interfaces ?? []).map((i) => [i.name ?? "", i] as const),
  );

  return networks.map((net) => {
    const iface = ifaceByName.get(net.name ?? "");
    const st = statusByName.get(net.name ?? "");
    const raw = st?.ipAddresses ?? (st?.ipAddress ? [st.ipAddress] : undefined);
    const ips = filterDisplayIps(raw);
    let binding: string | undefined;
    if (iface?.masquerade != null) binding = "masquerade";
    else if (iface?.bridge != null) binding = "bridge";
    return {
      name: net.name ?? "",
      model: iface?.model,
      binding,
      multusNetworkName: net.multus?.networkName,
      pod: net.pod != null,
      mac: st?.mac ?? iface?.macAddress,
      ipAddresses: ips,
      guestInterfaceName: st?.interfaceName || undefined,
      linkState: st?.linkState || undefined,
    };
  });
}

function isVpcNadLabels(labels: Record<string, string>): boolean {
  const resource = labels[KMC_LABEL_RESOURCE];
  if (resource === KMC_RESOURCE_VPC) return true;
  if (resource === KMC_RESOURCE_NETWORK) return false;
  // Legacy: managed VPC NAD before resource label was always set.
  return (
    labels[MANAGED_BY_LABEL] === KMC_MANAGED_BY && labels[KMC_LABEL_VLAN] != null
  );
}

/** Attach VPC detail coords for Multus networks that resolve to kmc VPC NADs. */
async function resolveNetworkVpcs(
  cluster: ClusterId,
  vmNamespace: string,
  networks: VmNetworkInfo[],
): Promise<VmNetworkInfo[]> {
  const { custom } = getClusterClients(cluster);
  return Promise.all(
    networks.map(async (net) => {
      if (!net.multusNetworkName?.trim()) return net;
      const ref = parseMultusNetworkRef(net.multusNetworkName, vmNamespace);
      if (!ref.name) return net;
      try {
        const nad = (await custom.getNamespacedCustomObject({
          group: "k8s.cni.cncf.io",
          version: "v1",
          namespace: ref.namespace,
          plural: "network-attachment-definitions",
          name: ref.name,
        })) as { metadata?: { labels?: Record<string, string> } };
        if (!isVpcNadLabels(nad.metadata?.labels ?? {})) return net;
        return {
          ...net,
          vpc: {
            cluster,
            namespace: ref.namespace,
            name: ref.name,
          },
        };
      } catch {
        return net;
      }
    }),
  );
}

interface GuestOsInfoSubresource {
  hostname?: string;
  guestAgentVersion?: string;
  timezone?: string;
  fsFreezeStatus?: string;
  os?: {
    id?: string;
    name?: string;
    prettyName?: string;
    version?: string;
    versionId?: string;
    kernelRelease?: string;
    kernelVersion?: string;
    machine?: string;
  };
  fsInfo?: {
    disks?: Array<{
      diskName?: string;
      mountPoint?: string;
      fileSystemType?: string;
      totalBytes?: number;
      usedBytes?: number;
    }>;
  };
}

function mapGuestAgent(
  vmi?: KubeVmi | null,
  guestOsInfo?: GuestOsInfoSubresource | null,
): VmGuestAgentInfo | undefined {
  if (!vmi) return undefined;
  const agentCond = vmi.status?.conditions?.find((c) => c.type === "AgentConnected");
  const connected = agentCond?.status === "True";
  // Prefer guestosinfo subresource (richer); fall back to VMI status.guestOSInfo.
  const os = guestOsInfo?.os ?? vmi.status?.guestOSInfo;

  const filesystems: VmGuestFilesystem[] = (guestOsInfo?.fsInfo?.disks ?? [])
    .filter((d) => d.mountPoint)
    .map((d) => ({
      mountPoint: d.mountPoint!,
      diskName: d.diskName || undefined,
      fileSystemType: d.fileSystemType || undefined,
      totalBytes:
        typeof d.totalBytes === "number" && Number.isFinite(d.totalBytes)
          ? d.totalBytes
          : undefined,
      usedBytes:
        typeof d.usedBytes === "number" && Number.isFinite(d.usedBytes)
          ? d.usedBytes
          : undefined,
    }))
    // Prefer root and common mounts first
    .sort((a, b) => {
      if (a.mountPoint === "/") return -1;
      if (b.mountPoint === "/") return 1;
      return a.mountPoint.localeCompare(b.mountPoint);
    });

  return {
    connected,
    hostname: guestOsInfo?.hostname || undefined,
    guestAgentVersion: guestOsInfo?.guestAgentVersion || undefined,
    timezone: guestOsInfo?.timezone || undefined,
    osId: os?.id || undefined,
    osPrettyName: os?.prettyName || undefined,
    osName: os?.name || undefined,
    osVersion: os?.version || os?.versionId || undefined,
    osVersionId: os?.versionId || undefined,
    osKernelRelease: os?.kernelRelease || undefined,
    osKernelVersion: os?.kernelVersion || undefined,
    osMachine: os?.machine || undefined,
    filesystems: filesystems.length > 0 ? filesystems : undefined,
  };
}

/**
 * KubeVirt guestosinfo subresource — hostname, timezone, agent version, FS usage.
 * Only useful when AgentConnected; failures are non-fatal.
 */
async function fetchGuestOsInfo(
  kc: KubeConfig,
  namespace: string,
  name: string,
): Promise<GuestOsInfoSubresource | null> {
  const path = `/apis/subresources.kubevirt.io/v1/namespaces/${encodeURIComponent(namespace)}/virtualmachineinstances/${encodeURIComponent(name)}/guestosinfo`;
  try {
    const res = await k8sFetch(kc, path, { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as GuestOsInfoSubresource;
  } catch {
    return null;
  }
}

function applyRootDiskFromIndex(
  summary: VmSummary,
  dvIndex: Map<string, DataVolumeDiskInfo>,
): void {
  if (summary.disk || !summary.diskDataVolume) return;
  const info = dvIndex.get(`${summary.namespace}/${summary.diskDataVolume}`);
  if (info?.size) summary.disk = info.size;
}

function mapVmDetail(
  cluster: ClusterId,
  vm: KubeVm,
  vmi?: KubeVmi | null,
  instanceTypes?: Map<string, InstanceTypeSize>,
  guestOsInfo?: GuestOsInfoSubresource | null,
  dvIndex?: Map<string, DataVolumeDiskInfo>,
): VmDetail {
  const summary = mapVm(cluster, vm, instanceTypes);
  if (dvIndex) applyRootDiskFromIndex(summary, dvIndex);
  const liveIpv4 = vmi?.status?.interfaces
    ?.flatMap((i) => i.ipAddresses ?? (i.ipAddress ? [i.ipAddress] : []))
    .filter((ip) => ip.trim() && !isLinkLocalIpv6(ip))?.[0];

  return {
    ...summary,
    uid: vm.metadata?.uid,
    nodeName: vmi?.status?.nodeName ?? summary.nodeName,
    runStrategy: vm.spec?.runStrategy,
    instanceType: summary.instanceType,
    preference: vm.spec?.preference?.name,
    machineType: vm.spec?.template?.spec?.domain?.machine?.type,
    architecture: vm.spec?.template?.spec?.architecture,
    labels: vm.metadata?.labels ?? {},
    annotations: vm.metadata?.annotations ?? {},
    conditions: (vm.status?.conditions ?? []).map((c) => ({
      type: c.type ?? "Unknown",
      status: c.status ?? "Unknown",
      reason: c.reason,
      message: c.message,
      lastTransitionTime: c.lastTransitionTime,
    })),
    volumes: mapVolumes(vm, dvIndex, vmi),
    networks: mapNetworks(vm, vmi),
    ipv4Address: liveIpv4,
    vmiPhase: vmi?.status?.phase,
    hasVmi: vmi != null,
    guestAgent: mapGuestAgent(vmi, guestOsInfo),
  };
}

export async function getVm(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<VmDetail> {
  const { custom, kc } = getClusterClients(cluster);

  let vm: KubeVm;
  try {
    vm = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name,
    })) as KubeVm;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404") || message.toLowerCase().includes("not found")) {
      throw new Response("Virtual machine not found", { status: 404 });
    }
    throw err;
  }

  let vmi: KubeVmi | null = null;
  try {
    vmi = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachineinstances",
      name,
    })) as KubeVmi;
  } catch {
    vmi = null;
  }

  const agentConnected =
    vmi?.status?.conditions?.some(
      (c) => c.type === "AgentConnected" && c.status === "True",
    ) ?? false;

  // Resolve standalone root DV sizes (no dataVolumeTemplates).
  const dvNames = collectVmDataVolumeNames(vm);
  const dvIndex = new Map<string, DataVolumeDiskInfo>();
  await Promise.all(
    dvNames.map(async (dvName) => {
      try {
        const dv = (await custom.getNamespacedCustomObject({
          group: "cdi.kubevirt.io",
          version: "v1beta1",
          namespace,
          plural: "datavolumes",
          name: dvName,
        })) as Parameters<typeof dataVolumeDiskInfo>[0];
        dvIndex.set(`${namespace}/${dvName}`, dataVolumeDiskInfo(dv));
      } catch {
        /* DV missing or unreadable */
      }
    }),
  );

  const [instanceTypes, guestOsInfo] = await Promise.all([
    loadInstanceTypeSizes(cluster),
    agentConnected ? fetchGuestOsInfo(kc, namespace, name) : Promise.resolve(null),
  ]);
  const detail = mapVmDetail(
    cluster,
    vm,
    vmi,
    instanceTypes,
    guestOsInfo,
    dvIndex,
  );
  const networks = await resolveNetworkVpcs(
    cluster,
    namespace,
    detail.networks,
  );
  return { ...detail, networks };
}

async function probeCluster(id: ClusterId): Promise<ClusterInfo> {
  try {
    const { custom, storage } = getClusterClients(id);
    await custom.listClusterCustomObject({
      group: "kubevirt.io",
      version: "v1",
      plural: "virtualmachines",
      limit: 1,
    });

    let hasInstanceTypes = false;
    try {
      const its = (await custom.listClusterCustomObject({
        group: "instancetype.kubevirt.io",
        version: "v1beta1",
        plural: "virtualmachineclusterinstancetypes",
        limit: 1,
      })) as { items?: unknown[] };
      hasInstanceTypes = (its.items?.length ?? 0) > 0;
    } catch {
      hasInstanceTypes = false;
    }

    let defaultStorageClass: string | undefined;
    try {
      const scs = await storage.listStorageClass();
      const items = scs.items ?? [];
      const def = items.find(
        (sc) =>
          sc.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] ===
            "true" ||
          sc.metadata?.annotations?.[
            "storageclass.beta.kubernetes.io/is-default-class"
          ] === "true",
      );
      defaultStorageClass = def?.metadata?.name ?? items[0]?.metadata?.name;
    } catch {
      // optional
    }

    return {
      id,
      reachable: true,
      hasInstanceTypes,
      defaultStorageClass,
    };
  } catch (err) {
    return {
      id,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
      hasInstanceTypes: false,
    };
  }
}

export async function listClusters(): Promise<ClusterInfo[]> {
  const contexts = getConfiguredContexts();
  return Promise.all(contexts.map(probeCluster));
}

export async function listVms(clusterFilter?: ClusterId): Promise<{
  items: VmSummary[];
  clusters: ClusterInfo[];
}> {
  // Always probe every configured context so health + filter dropdowns stay complete
  // when `?cluster=` narrows which VMs are fetched.
  const allContexts = getConfiguredContexts();
  const clusters = await Promise.all(allContexts.map(probeCluster));
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const fetchIds = clusterFilter ? [clusterFilter] : allContexts;
  const items: VmSummary[] = [];

  await Promise.all(
    fetchIds.map(async (id) => {
      const cluster = byId.get(id);
      if (!cluster?.reachable) return;
      try {
        const { custom, core, networking } = getClusterClients(id);
        const [res, instanceTypes, floats, dvIndex, backendSvcs, ings] =
          await Promise.all([
            custom.listClusterCustomObject({
              group: "kubevirt.io",
              version: "v1",
              plural: "virtualmachines",
            }) as Promise<{ items?: KubeVm[] }>,
            loadInstanceTypeSizes(id),
            listFloatingIps(id).then((r) => r.items).catch(() => []),
            loadClusterDataVolumeDiskIndex(id),
            core
              .listServiceForAllNamespaces({
                labelSelector: KMC_BACKEND_LABEL_SELECTOR,
              })
              .catch(() => ({ items: [] as unknown[] })),
            networking
              .listIngressForAllNamespaces({
                labelSelector: KMC_INGRESS_LABEL_SELECTOR,
              })
              .catch(() => ({ items: [] as unknown[] })),
          ]);

        // Map floating public IPs → VMs by targetVm name or private IPAM address.
        const floatsByVmKey = new Map<string, string[]>();
        const privateToVmKey = new Map<string, string>();
        for (const vm of res.items ?? []) {
          const name = vm.metadata?.name;
          const namespace = vm.metadata?.namespace;
          if (!name || !namespace) continue;
          const key = `${namespace}/${name}`;
          const ann = vm.metadata?.annotations?.[IPAM_ANNOTATION_IPV4];
          if (ann) {
            for (const addr of parseIpv4AnnotationList(ann)) {
              privateToVmKey.set(`${namespace}|${addr}`, key);
            }
          }
        }
        for (const f of floats) {
          if (f.state !== "associated") continue;
          const publicAddr =
            addressFromIpv4Annotation(f.public) ?? f.public.trim();
          if (!publicAddr) continue;
          let key: string | undefined;
          if (f.targetVm?.trim()) {
            key = `${f.namespace}/${f.targetVm.trim()}`;
          } else if (f.private?.trim()) {
            const priv = addressFromIpv4Annotation(f.private) ?? f.private.trim();
            if (priv) key = privateToVmKey.get(`${f.namespace}|${priv}`);
          }
          if (!key) continue;
          const list = floatsByVmKey.get(key) ?? [];
          if (!list.includes(publicAddr)) list.push(publicAddr);
          floatsByVmKey.set(key, list);
        }

        // Exposure chips: single-vm Ingress hosts + LoadBalancer VIPs (cheap path).
        const ingressHostsByVm = new Map<string, string[]>();
        for (const raw of (ings as { items?: unknown[] }).items ?? []) {
          const ing = raw as {
            metadata?: {
              namespace?: string;
              labels?: Record<string, string>;
            };
            spec?: { rules?: Array<{ host?: string }> };
          };
          const labels = ing.metadata?.labels ?? {};
          if (labels[KMC_LABEL_TARGET_KIND] && labels[KMC_LABEL_TARGET_KIND] !== KMC_TARGET_KIND_VM) {
            continue;
          }
          const vmName = labels[KMC_LABEL_VM];
          const ns = ing.metadata?.namespace;
          if (!vmName || !ns) continue;
          const hosts = (ing.spec?.rules ?? [])
            .map((r) => r.host?.trim())
            .filter((h): h is string => Boolean(h));
          if (!hosts.length) continue;
          const key = `${ns}/${vmName}`;
          const list = ingressHostsByVm.get(key) ?? [];
          for (const h of hosts) {
            if (!list.includes(h)) list.push(h);
          }
          ingressHostsByVm.set(key, list);
        }

        const lbAddrsByVm = new Map<string, string[]>();
        for (const raw of (backendSvcs as { items?: unknown[] }).items ?? []) {
          const svc = raw as {
            metadata?: {
              namespace?: string;
              labels?: Record<string, string>;
            };
            spec?: { type?: string };
            status?: {
              loadBalancer?: {
                ingress?: Array<{ ip?: string; hostname?: string }>;
              };
            };
          };
          if ((svc.spec?.type ?? "ClusterIP") !== "LoadBalancer") continue;
          const labels = svc.metadata?.labels ?? {};
          if (labels[KMC_LABEL_TARGET_KIND] !== KMC_TARGET_KIND_VM) continue;
          const vmName = labels[KMC_LABEL_VM];
          const ns = svc.metadata?.namespace;
          if (!vmName || !ns) continue;
          const lb = svc.status?.loadBalancer?.ingress?.[0];
          const addr = lb?.hostname || lb?.ip;
          if (!addr) continue;
          const key = `${ns}/${vmName}`;
          const list = lbAddrsByVm.get(key) ?? [];
          if (!list.includes(addr)) list.push(addr);
          lbAddrsByVm.set(key, list);
        }

        for (const vm of res.items ?? []) {
          const summary = mapVm(id, vm, instanceTypes);
          applyRootDiskFromIndex(summary, dvIndex);
          const key = `${summary.namespace}/${summary.name}`;
          const floatingIpv4 = floatsByVmKey.get(key);
          if (floatingIpv4?.length) {
            summary.floatingIpv4 = floatingIpv4;
          }
          const hosts = ingressHostsByVm.get(key);
          if (hosts?.length) summary.ingressHosts = hosts;
          const lbAddrs = lbAddrsByVm.get(key);
          if (lbAddrs?.length) summary.loadBalancerAddresses = lbAddrs;
          items.push(summary);
        }
      } catch (err) {
        cluster.reachable = false;
        cluster.error = err instanceof Error ? err.message : String(err);
      }
    }),
  );

  items.sort((a, b) => {
    const ca = a.cluster.localeCompare(b.cluster);
    if (ca !== 0) return ca;
    const na = a.namespace.localeCompare(b.namespace);
    if (na !== 0) return na;
    return a.name.localeCompare(b.name);
  });

  return { items, clusters };
}

async function deleteDataVolumeRaw(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  const { custom } = getClusterClients(cluster);
  try {
    await custom.deleteNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      name,
    });
  } catch (err) {
    if (isNotFoundError(err)) return;
    throw new Error(formatError(err), { cause: err });
  }
}

/**
 * Create a standalone root DataVolume (PVC clone from golden image).
 * Not owned by the VM — lifecycle is managed by kmc delete/retain.
 *
 * @returns name of the DataVolume and whether it was created in this call
 */
export async function ensureRootDataVolumeFromImage(opts: {
  cluster: ClusterId;
  namespace: string;
  /** DataVolume name (typically the VM name). */
  name: string;
  diskSize: string;
  storageClass?: string;
  image: { namespace?: string; name: string };
  /** Extra labels (e.g. router role). kubevirt.io/vm is set automatically. */
  labels?: Record<string, string>;
  /**
   * When true and a DV already exists, delete it and create a fresh clone.
   * Used by router appliance recreate (historical template behavior).
   */
  replace?: boolean;
}): Promise<{ name: string; created: boolean }> {
  const name = opts.name.trim();
  if (!name) throw new Error("DataVolume name is required");
  if (!opts.diskSize?.trim()) throw new Error("diskSize is required");
  if (!opts.image?.name?.trim()) throw new Error("image is required");

  const { custom } = getClusterClients(opts.cluster);
  let exists = false;
  try {
    await custom.getNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace: opts.namespace,
      plural: "datavolumes",
      name,
    });
    exists = true;
  } catch (err) {
    if (!isNotFoundError(err)) throw new Error(formatError(err), { cause: err });
  }

  if (exists && !opts.replace) {
    return { name, created: false };
  }
  if (exists && opts.replace) {
    await deleteDataVolumeRaw(opts.cluster, opts.namespace, name);
  }

  const imageNs = opts.image.namespace || "vm-images";
  try {
    await custom.createNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace: opts.namespace,
      plural: "datavolumes",
      body: {
        apiVersion: "cdi.kubevirt.io/v1beta1",
        kind: "DataVolume",
        metadata: {
          name,
          namespace: opts.namespace,
          labels: {
            [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
            "kubevirt.io/vm": name,
            ...(opts.labels ?? {}),
          },
        },
        spec: {
          source: {
            pvc: {
              name: opts.image.name,
              namespace: imageNs,
            },
          },
          storage: {
            accessModes: ["ReadWriteOnce"],
            volumeMode: "Block",
            resources: {
              requests: {
                storage: opts.diskSize.trim(),
              },
            },
            ...(opts.storageClass
              ? { storageClassName: opts.storageClass }
              : {}),
          },
        },
      },
    });
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
  return { name, created: true };
}

/**
 * Create a blank standalone DataVolume for a secondary disk.
 * Lifecycle is managed by kmc (delete/retain / detach), not ownerRefs.
 */
export async function ensureBlankDataVolume(opts: {
  cluster: ClusterId;
  namespace: string;
  name: string;
  size: string;
  storageClass?: string;
  /** VirtualMachine name for kubevirt.io/vm label (actual VM, not DV name). */
  vmName: string;
}): Promise<{ name: string; created: boolean }> {
  const name = opts.name.trim();
  if (!name) throw new Error("DataVolume name is required");
  if (!opts.size?.trim()) throw new Error("size is required");
  if (!opts.vmName?.trim()) throw new Error("vmName is required");

  const { custom } = getClusterClients(opts.cluster);
  try {
    await custom.getNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace: opts.namespace,
      plural: "datavolumes",
      name,
    });
    return { name, created: false };
  } catch (err) {
    if (!isNotFoundError(err)) throw new Error(formatError(err), { cause: err });
  }

  try {
    await custom.createNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace: opts.namespace,
      plural: "datavolumes",
      body: {
        apiVersion: "cdi.kubevirt.io/v1beta1",
        kind: "DataVolume",
        metadata: {
          name,
          namespace: opts.namespace,
          labels: {
            [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
            "kubevirt.io/vm": opts.vmName.trim(),
          },
        },
        spec: {
          source: { blank: {} },
          storage: {
            accessModes: ["ReadWriteOnce"],
            volumeMode: "Block",
            resources: {
              requests: {
                storage: opts.size.trim(),
              },
            },
            ...(opts.storageClass
              ? { storageClassName: opts.storageClass }
              : {}),
          },
        },
      },
    });
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
  return { name, created: true };
}

/** Stable DV name for a secondary volume: `{vm}-{volume}`, ≤63 chars. */
export function secondaryDataVolumeName(
  vmName: string,
  volumeName: string,
): string {
  const vm = vmName.trim();
  const vol = volumeName.trim();
  const combined = `${vm}-${vol}`;
  if (combined.length <= 63) return combined;
  const maxVm = 63 - 1 - vol.length;
  if (maxVm < 1) {
    throw new Error(
      `Volume name "${vol}" is too long to form a DataVolume name with VM "${vm}"`,
    );
  }
  return `${vm.slice(0, maxVm)}-${vol}`;
}

function existingVolumeNames(vm: KubeVm): Set<string> {
  return new Set(
    (vm.spec?.template?.spec?.volumes ?? [])
      .map((v) => v.name?.trim() ?? "")
      .filter(Boolean),
  );
}

function countSecondaryDataDisks(vm: KubeVm): number {
  return (vm.spec?.template?.spec?.volumes ?? []).filter((v) => {
    const n = v.name?.trim() ?? "";
    if (!n || RESERVED_VOLUME_NAME_SET.has(n)) return false;
    return Boolean(v.dataVolume?.name || v.persistentVolumeClaim?.claimName);
  }).length;
}

function validateVolumeName(name: string): void {
  if (!name) throw new Error("Volume name is required");
  if (name.length > 63) throw new Error("Volume name max 63 characters");
  if (!DNS1123_LABEL.test(name)) {
    throw new Error(
      "Volume name must be a DNS-1123 label (lowercase alphanumeric and hyphens)",
    );
  }
  if (RESERVED_VOLUME_NAME_SET.has(name)) {
    throw new Error(`Volume name "${name}" is reserved`);
  }
}

/**
 * Pick a free volume name on the VM (`disk-N` or validate preferred).
 */
function allocateVolumeName(vm: KubeVm, preferred?: string): string {
  const used = existingVolumeNames(vm);
  if (preferred?.trim()) {
    const name = preferred.trim();
    validateVolumeName(name);
    if (used.has(name)) {
      throw new Error(`Volume name "${name}" is already attached to this VM`);
    }
    return name;
  }
  for (let i = 1; i <= KMC_MAX_EXTRA_DISKS + 32; i++) {
    const candidate = `disk-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a free volume name");
}

function resolveExtraDiskSource(
  disk: CreateVmExtraDisk,
): VmDiskSourceMode {
  return disk.source === "existingDataVolume" ? "existingDataVolume" : "blank";
}

/**
 * Materialize create-time extra disks (blank create or validate existing).
 * Returns resolved volume/DV names and any DVs created in this call (for rollback).
 */
async function materializeExtraDisks(opts: {
  cluster: ClusterId;
  namespace: string;
  vmName: string;
  extraDisks: CreateVmExtraDisk[];
  /** Volume names already claimed (root/cloudinit + prior extras). */
  reservedNames: Set<string>;
}): Promise<{ resolved: ResolvedExtraDisk[]; createdDvNames: string[] }> {
  const { cluster, namespace, vmName, extraDisks } = opts;
  if (extraDisks.length === 0) return { resolved: [], createdDvNames: [] };
  if (extraDisks.length > KMC_MAX_EXTRA_DISKS) {
    throw new Error(
      `At most ${KMC_MAX_EXTRA_DISKS} secondary disks are supported`,
    );
  }

  const used = new Set(opts.reservedNames);
  // Seed reserved with synthetic root/cloudinit so allocate never collides.
  used.add("root");
  used.add("cloudinit");

  const resolved: ResolvedExtraDisk[] = [];
  const createdDvNames: string[] = [];
  const usedDvNames = new Set<string>();

  try {
    for (let i = 0; i < extraDisks.length; i++) {
      const disk = extraDisks[i]!;
      const source = resolveExtraDiskSource(disk);

      let volumeName: string;
      if (disk.name?.trim()) {
        volumeName = disk.name.trim();
        validateVolumeName(volumeName);
        if (used.has(volumeName)) {
          throw new Error(`Duplicate volume name "${volumeName}"`);
        }
      } else {
        volumeName = "";
        for (let n = 1; n <= KMC_MAX_EXTRA_DISKS + 32; n++) {
          const candidate = `disk-${n}`;
          if (!used.has(candidate)) {
            volumeName = candidate;
            break;
          }
        }
        if (!volumeName) throw new Error("Could not allocate a free volume name");
      }
      used.add(volumeName);

      let dataVolumeName: string;
      if (source === "existingDataVolume") {
        dataVolumeName = disk.existingDataVolumeName?.trim() ?? "";
        if (!dataVolumeName) {
          throw new Error(
            `extraDisks[${i}]: existingDataVolumeName is required when source is existingDataVolume`,
          );
        }
        validateVolumeName(dataVolumeName); // DNS-1123 for DV names
        if (usedDvNames.has(dataVolumeName)) {
          throw new Error(
            `DataVolume ${dataVolumeName} is listed more than once`,
          );
        }
        await assertDataVolumeReusable({
          cluster,
          namespace,
          dataVolumeName,
        });
      } else {
        const size = disk.size?.trim();
        if (!size) {
          throw new Error(`extraDisks[${i}]: size is required for blank disks`);
        }
        dataVolumeName = secondaryDataVolumeName(vmName, volumeName);
        if (usedDvNames.has(dataVolumeName)) {
          throw new Error(`DataVolume name collision: ${dataVolumeName}`);
        }
        const result = await ensureBlankDataVolume({
          cluster,
          namespace,
          name: dataVolumeName,
          size,
          storageClass: disk.storageClass,
          vmName,
        });
        if (result.created) createdDvNames.push(result.name);
      }
      usedDvNames.add(dataVolumeName);
      resolved.push({ volumeName, dataVolumeName });
    }
  } catch (err) {
    for (const dv of createdDvNames) {
      try {
        await deleteDataVolumeRaw(cluster, namespace, dv);
      } catch {
        /* ignore */
      }
    }
    throw err;
  }

  return { resolved, createdDvNames };
}

async function fetchVmRaw(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<KubeVm> {
  const { custom } = getClusterClients(cluster);
  try {
    return (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name,
    })) as KubeVm;
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(`VirtualMachine not found: ${namespace}/${name}`);
    }
    throw new Error(formatError(err), { cause: err });
  }
}

/**
 * Declarative hotplug attach (DeclarativeHotplugVolumes):
 * GET + replace VM template with a hotpluggable disk + DataVolume volume.
 * Works while running (controller hotplugs) or stopped (present on next start).
 * Single 409 retry with fresh resourceVersion.
 */
async function attachVolumeDeclarative(opts: {
  cluster: ClusterId;
  namespace: string;
  vmName: string;
  volumeName: string;
  dataVolumeName: string;
}): Promise<void> {
  const { custom } = getClusterClients(opts.cluster);
  const attempt = async (): Promise<void> => {
    const vm = await fetchVmRaw(opts.cluster, opts.namespace, opts.vmName);
    const body = structuredClone(vm) as KubeVm & Record<string, unknown>;
    delete (body as { status?: unknown }).status;

    const templateSpec = body.spec?.template?.spec;
    if (!templateSpec) {
      throw new Error("VirtualMachine has no template.spec");
    }
    const domain = templateSpec.domain ?? {};
    const devices = domain.devices ?? {};
    const disks = [...(devices.disks ?? [])];
    const volumes = [...(templateSpec.volumes ?? [])];

    if (volumes.some((v) => v.name === opts.volumeName)) {
      throw new Error(`Volume "${opts.volumeName}" already exists on the VM`);
    }
    if (disks.some((d) => d.name === opts.volumeName)) {
      throw new Error(`Disk "${opts.volumeName}" already exists on the VM`);
    }

    disks.push({ name: opts.volumeName, disk: { bus: "scsi" } });
    volumes.push({
      name: opts.volumeName,
      dataVolume: { name: opts.dataVolumeName, hotpluggable: true },
    });

    devices.disks = disks;
    domain.devices = devices;
    templateSpec.domain = domain;
    templateSpec.volumes = volumes;
    body.spec = body.spec ?? {};
    body.spec.template = body.spec.template ?? {};
    body.spec.template.spec = templateSpec;

    await custom.replaceNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace: opts.namespace,
      plural: "virtualmachines",
      name: opts.vmName,
      body,
    });
  };

  try {
    await attempt();
  } catch (err) {
    if (!isConflictError(err)) {
      throw new Error(formatError(err), { cause: err });
    }
    try {
      await attempt();
    } catch (retryErr) {
      throw new Error(formatError(retryErr), { cause: retryErr });
    }
  }
}

/**
 * Declarative hotplug detach: remove disk + volume from the VM template.
 * Single 409 retry with fresh resourceVersion.
 */
async function detachVolumeDeclarative(opts: {
  cluster: ClusterId;
  namespace: string;
  vmName: string;
  volumeName: string;
}): Promise<void> {
  const { custom } = getClusterClients(opts.cluster);
  const attempt = async (): Promise<void> => {
    const vm = await fetchVmRaw(opts.cluster, opts.namespace, opts.vmName);
    const body = structuredClone(vm) as KubeVm & Record<string, unknown>;
    delete (body as { status?: unknown }).status;

    const templateSpec = body.spec?.template?.spec;
    if (!templateSpec) {
      throw new Error("VirtualMachine has no template.spec");
    }
    const domain = templateSpec.domain ?? {};
    const devices = domain.devices ?? {};
    const beforeDisks = devices.disks ?? [];
    const beforeVolumes = templateSpec.volumes ?? [];
    const disks = beforeDisks.filter((d) => d.name !== opts.volumeName);
    const volumes = beforeVolumes.filter((v) => v.name !== opts.volumeName);

    if (
      volumes.length === beforeVolumes.length &&
      disks.length === beforeDisks.length
    ) {
      throw new Error(`Volume "${opts.volumeName}" not found on the VM`);
    }

    devices.disks = disks;
    domain.devices = devices;
    templateSpec.domain = domain;
    templateSpec.volumes = volumes;
    body.spec = body.spec ?? {};
    body.spec.template = body.spec.template ?? {};
    body.spec.template.spec = templateSpec;

    await custom.replaceNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace: opts.namespace,
      plural: "virtualmachines",
      name: opts.vmName,
      body,
    });
  };

  try {
    await attempt();
  } catch (err) {
    if (!isConflictError(err)) {
      throw new Error(formatError(err), { cause: err });
    }
    try {
      await attempt();
    } catch (retryErr) {
      throw new Error(formatError(retryErr), { cause: retryErr });
    }
  }
}

/**
 * Attach a secondary data disk (blank or existing DV) via declarative hotplug.
 * Requires KubeVirt feature gate DeclarativeHotplugVolumes for live attach;
 * stopped VMs still accept the spec change for the next start.
 */
export async function attachVmDisk(
  input: AttachVmDiskRequest,
): Promise<AttachVmDiskResult> {
  const cluster = input.cluster?.trim();
  const namespace = input.namespace?.trim();
  const vmName = input.vmName?.trim();
  if (!cluster) throw new Error("cluster is required");
  if (!namespace) throw new Error("namespace is required");
  if (!vmName) throw new Error("vmName is required");

  await assertVmNamespaceAllowed(cluster, namespace);

  const vm = await fetchVmRaw(cluster, namespace, vmName);
  if (countSecondaryDataDisks(vm) >= KMC_MAX_EXTRA_DISKS) {
    throw new Error(
      `At most ${KMC_MAX_EXTRA_DISKS} secondary disks are supported`,
    );
  }

  const volumeName = allocateVolumeName(vm, input.name);
  const source: VmDiskSourceMode =
    input.source === "existingDataVolume" ? "existingDataVolume" : "blank";

  let dataVolumeName: string;
  let createdDataVolume = false;

  if (source === "existingDataVolume") {
    dataVolumeName = input.existingDataVolumeName?.trim() ?? "";
    if (!dataVolumeName) {
      throw new Error("existingDataVolumeName is required");
    }
    if (!DNS1123_LABEL.test(dataVolumeName)) {
      throw new Error("existingDataVolumeName must be a DNS-1123 label");
    }
    // Already attached to this VM?
    const already = (vm.spec?.template?.spec?.volumes ?? []).some(
      (v) => v.dataVolume?.name === dataVolumeName,
    );
    if (already) {
      throw new Error(
        `DataVolume ${dataVolumeName} is already attached to this VM`,
      );
    }
    await assertDataVolumeReusable({
      cluster,
      namespace,
      dataVolumeName,
    });
  } else {
    const size = input.size?.trim();
    if (!size) throw new Error("size is required for blank disks");
    dataVolumeName = secondaryDataVolumeName(vmName, volumeName);
    const result = await ensureBlankDataVolume({
      cluster,
      namespace,
      name: dataVolumeName,
      size,
      storageClass: input.storageClass,
      vmName,
    });
    createdDataVolume = result.created;
    // If DV already existed but was not reusable/attached, refuse reuse of a non-blank path.
    if (!result.created) {
      // Existing DV with same auto name — only allow if reusable (unattached).
      try {
        await assertDataVolumeReusable({
          cluster,
          namespace,
          dataVolumeName,
        });
      } catch (err) {
        throw new Error(
          `DataVolume ${dataVolumeName} already exists and cannot be attached: ${formatError(err)}`,
          { cause: err },
        );
      }
    }
  }

  try {
    await attachVolumeDeclarative({
      cluster,
      namespace,
      vmName,
      volumeName,
      dataVolumeName,
    });
  } catch (err) {
    if (createdDataVolume) {
      try {
        await deleteDataVolumeRaw(cluster, namespace, dataVolumeName);
      } catch {
        /* ignore */
      }
    }
    throw err instanceof Error ? err : new Error(formatError(err), { cause: err });
  }

  // Clear retain labels / stamp kubevirt.io/vm for blank and reused DVs.
  await stampDataVolumeAttachedToVm({
    cluster,
    namespace,
    dvName: dataVolumeName,
    vmName,
  });

  return { volumeName, dataVolumeName, createdDataVolume };
}

/**
 * Detach a secondary data disk via declarative hotplug (remove from VM spec).
 * Default keeps the DataVolume (retain stamp). Optional deleteDisk removes it.
 */
export async function detachVmDisk(
  input: DetachVmDiskRequest,
): Promise<DetachVmDiskResult> {
  const cluster = input.cluster?.trim();
  const namespace = input.namespace?.trim();
  const vmName = input.vmName?.trim();
  const volumeName = input.volumeName?.trim();
  if (!cluster) throw new Error("cluster is required");
  if (!namespace) throw new Error("namespace is required");
  if (!vmName) throw new Error("vmName is required");
  if (!volumeName) throw new Error("volumeName is required");

  if (RESERVED_VOLUME_NAME_SET.has(volumeName)) {
    throw new Error(`Cannot detach reserved volume "${volumeName}"`);
  }

  const vm = await fetchVmRaw(cluster, namespace, vmName);
  const vol = (vm.spec?.template?.spec?.volumes ?? []).find(
    (v) => v.name === volumeName,
  );
  if (!vol) {
    throw new Error(`Volume "${volumeName}" not found on the VM`);
  }
  const dataVolumeName = vol.dataVolume?.name?.trim();
  if (!dataVolumeName) {
    throw new Error(
      `Volume "${volumeName}" is not a DataVolume and cannot be detached from the console`,
    );
  }

  await detachVolumeDeclarative({ cluster, namespace, vmName, volumeName });

  let deletedDataVolume = false;
  let retainedDataVolume = false;

  if (input.deleteDisk === true) {
    try {
      await deleteDataVolumeRaw(cluster, namespace, dataVolumeName);
      deletedDataVolume = true;
    } catch (err) {
      throw new Error(
        `Disk detached but failed to delete DataVolume ${dataVolumeName}: ${formatError(err)}`,
        { cause: err },
      );
    }
  } else {
    try {
      const { custom } = getClusterClients(cluster);
      const stamped = await stampRetainedDataVolume({
        custom,
        namespace,
        dvName: dataVolumeName,
        vmName,
      });
      retainedDataVolume = stamped;
    } catch {
      // Detach succeeded; retain stamp is best-effort.
      retainedDataVolume = false;
    }
  }

  return {
    volumeName,
    dataVolumeName,
    deletedDataVolume,
    retainedDataVolume,
  };
}

export async function createVm(input: CreateVmRequest): Promise<VmSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!input.sshPublicKey?.trim()) throw new Error("sshPublicKey is required");

  const diskSource = createVmDiskSource(input);
  /** Stamped on the VM so list/detail can show size without templates. */
  let rootDiskSizeAnn: string | undefined;
  if (diskSource === "image") {
    if (!input.diskSize?.trim()) throw new Error("diskSize is required");
    if (!input.image?.name?.trim()) throw new Error("image is required");
    rootDiskSizeAnn = input.diskSize.trim();
  } else {
    const dvName = input.existingDataVolumeName?.trim();
    if (!dvName) throw new Error("existingDataVolumeName is required");
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(dvName)) {
      throw new Error("existingDataVolumeName must be a DNS-1123 label");
    }
    const reusable = await assertDataVolumeReusable({
      cluster: input.cluster,
      namespace: input.namespace,
      dataVolumeName: dvName,
    });
    rootDiskSizeAnn = reusable.size?.trim() || undefined;
  }

  if (!input.instanceType && !(input.cpuCores && input.memory)) {
    throw new Error("Provide instanceType or both cpuCores and memory");
  }

  await assertVmNamespaceAllowed(input.cluster, input.namespace);

  const multusNames = multusNetworksFromRequest(input);
  const unique = new Set(multusNames);
  if (unique.size !== multusNames.length) {
    throw new Error("Duplicate Multus networks are not allowed");
  }
  if (multusNames.length > 8) {
    throw new Error("At most 8 Multus network attachments are supported");
  }

  // Materialize shared Multus NADs (e.g. external) from IPPool.spec.cni when missing.
  await ensureStaticMultusNads(input.cluster, input.namespace, multusNames);

  const { custom } = getClusterClients(input.cluster);

  const vmName = input.name.trim();
  const claimedAddresses: string[] = [];
  const releaseClaims = async () => {
    if (claimedAddresses.length === 0) return;
    await releaseIpAddressClaims(
      input.cluster,
      input.namespace,
      claimedAddresses,
    );
  };

  try {
    // Sequential so multi-attach can reserve prior picks via extraUsed.
    // MAC is chosen before claim so IPAddress.spec.interface enables DHCP leases.
    // Router-backed VPCs: skip console claim — guest uses DHCP; VirtualMachineIPAM
    // controller allocates IPAddress after create (MAC already stamped on the iface).
    // Static Multus (IPPool / VPC without router): still pre-claim for cloud-init netplan.
    const dualHome =
      multusNames.length > 0 && input.includePodNetwork !== false;
    const rawAllocations: Array<
      Awaited<ReturnType<typeof allocateIpv4ForMultus>> | AllocatedIp
    > = [];
    const extraUsed: string[] = [];
    for (const name of multusNames) {
      const mac = generateLocalMacAddress();
      const ref = parseMultusNetworkRef(name, input.namespace);
      if (ref.namespace === input.namespace) {
        const routerName = await readVpcRouterName(
          input.cluster,
          ref.namespace,
          ref.name,
        );
        if (routerName) {
          rawAllocations.push(dhcpDeferredMultusAllocation(mac));
          continue;
        }
      }

      const alloc = await allocateIpv4ForMultus(
        input.cluster,
        name,
        input.namespace,
        {
          extraUsed,
          claim: { name: vmName, namespace: input.namespace },
          interface: { mac, hostname: vmName },
        },
      );
      if (alloc) {
        alloc.macAddress = mac;
        extraUsed.push(alloc.address);
        claimedAddresses.push(alloc.address);
      }
      rawAllocations.push(alloc);
    }
    const allocations = bindAllocationsToNetworks(multusNames, rawAllocations, {
      // Always MAC-match Multus when dual-home or any DHCP NIC (router path).
      forceMac:
        dualHome || rawAllocations.some((a) => a != null && a.dhcp4 === true),
    });

    // Standalone root disk (not dataVolumeTemplates) so DV outlives the VM by default.
    let createdRootDv: string | null = null;
    if (diskSource === "image") {
      try {
        const result = await ensureRootDataVolumeFromImage({
          cluster: input.cluster,
          namespace: input.namespace,
          name: vmName,
          diskSize: input.diskSize!,
          storageClass: input.storageClass,
          image: {
            namespace: input.image!.namespace,
            name: input.image!.name,
          },
        });
        if (result.created) createdRootDv = result.name;
      } catch (err) {
        throw new Error(
          `Failed to create root DataVolume: ${formatError(err)}`,
          { cause: err },
        );
      }
    }

    // Secondary data disks (standalone blank / existing DVs).
    const extraDisksInput = input.extraDisks ?? [];
    let resolvedExtraDisks: ResolvedExtraDisk[] = [];
    let createdExtraDvs: string[] = [];
    if (extraDisksInput.length > 0) {
      const material = await materializeExtraDisks({
        cluster: input.cluster,
        namespace: input.namespace,
        vmName,
        extraDisks: extraDisksInput,
        reservedNames: new Set(["root", "cloudinit"]),
      });
      resolvedExtraDisks = material.resolved;
      createdExtraDvs = material.createdDvNames;
    }

    // Platform console key so browser Terminal can SSH without the user's private key.
    const platformPub = await getPlatformConsolePublicKey();
    // Dual-home: route cluster CIDRs via masquerade GW (not Multus default).
    let clusterCidrs: string[] | undefined;
    if (dualHome) {
      const net = getClusterNetwork(input.cluster);
      if (net) {
        const { podCIDRs, serviceCIDRs } = clusterNetworkCidrList(net);
        clusterCidrs = [...podCIDRs, ...serviceCIDRs]
          .map((c) => c.trim())
          .filter(Boolean);
      }
    }
    const body = buildVirtualMachineManifest(input, allocations, {
      extraAuthorizedKeys: platformPub ? [platformPub] : [],
      includePodNetwork: dualHome,
      clusterCidrs,
      extraDisks: resolvedExtraDisks,
    }) as {
      metadata?: { annotations?: Record<string, string> };
      [key: string]: unknown;
    };
    if (rootDiskSizeAnn) {
      body.metadata = body.metadata ?? {};
      body.metadata.annotations = {
        ...(body.metadata.annotations ?? {}),
        [KMC_ANN_DISK_SIZE]: rootDiskSizeAnn,
      };
    }

    const rollbackCreatedDisks = async () => {
      if (createdRootDv) {
        try {
          await deleteDataVolumeRaw(
            input.cluster,
            input.namespace,
            createdRootDv,
          );
        } catch {
          /* ignore */
        }
      }
      for (const dv of createdExtraDvs) {
        try {
          await deleteDataVolumeRaw(input.cluster, input.namespace, dv);
        } catch {
          /* ignore */
        }
      }
    };

    try {
      const created = (await custom.createNamespacedCustomObject({
        group: "kubevirt.io",
        version: "v1",
        namespace: input.namespace,
        plural: "virtualmachines",
        body,
      })) as KubeVm;
      const instanceTypes = input.instanceType
        ? await loadInstanceTypeSizes(input.cluster)
        : undefined;
      const summary = mapVm(input.cluster, created, instanceTypes);
      if (!summary.disk && rootDiskSizeAnn) summary.disk = rootDiskSizeAnn;
      return summary;
    } catch (err) {
      // Remove DVs we just created so retries are clean
      await rollbackCreatedDisks();
      throw new Error(formatError(err), { cause: err });
    }
  } catch (err) {
    await releaseClaims();
    throw err;
  }
}

/** Read status.routerRef from a VPC CR (controller-managed). */
async function readVpcRouterName(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
): Promise<string | undefined> {
  try {
    const vpc = await getNamespacedCustomObject<VpcCr>(
      cluster,
      namespace,
      PLURAL_VPCS,
      vpcName,
    );
    return vpc.status?.routerRef?.name?.trim() || undefined;
  } catch (err) {
    if (isNotFoundError(err)) return undefined;
    return undefined;
  }
}

/**
 * Edit labels always; size / preference / runStrategy when stopped or while
 * running (LiveUpdate). Prefer runStrategy over the deprecated `running` field.
 */
export async function updateVm(input: UpdateVmRequest): Promise<VmDetail> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!input.labels || typeof input.labels !== "object") {
    throw new Error("labels are required");
  }

  const { custom } = getClusterClients(input.cluster);
  let existing: KubeVm;
  try {
    existing = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace: input.namespace,
      plural: "virtualmachines",
      name: input.name,
    })) as KubeVm;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404") || message.toLowerCase().includes("not found")) {
      throw new Response("Virtual machine not found", { status: 404 });
    }
    throw err;
  }

  const current = mapVm(input.cluster, existing);
  const body = structuredClone(existing) as KubeVm & {
    metadata: NonNullable<KubeVm["metadata"]>;
    spec: NonNullable<KubeVm["spec"]> & Record<string, unknown>;
  };

  body.metadata = body.metadata ?? {};
  body.metadata.labels = { ...input.labels };
  body.spec = body.spec ?? {};

  if (input.spec) {
    if (!canEditVmSpec(current)) {
      throw new Error(
        `Cannot change size, preference, or run strategy while status is ${current.status}`,
      );
    }

    const runStrategy = input.spec.runStrategy.trim();
    if (!runStrategy) throw new Error("runStrategy is required");
    if (!(VM_RUN_STRATEGIES as readonly string[]).includes(runStrategy)) {
      throw new Error(
        `Invalid runStrategy "${runStrategy}". Allowed: ${VM_RUN_STRATEGIES.join(", ")}`,
      );
    }
    body.spec.runStrategy = runStrategy;
    // Deprecated boolean conflicts with runStrategy; never write it.
    delete body.spec.running;

    if (input.spec.sizeMode === "instancetype") {
      const itName = input.spec.instanceType?.trim();
      if (!itName) throw new Error("instanceType is required in instancetype mode");
      body.spec.instancetype = {
        kind: "VirtualMachineClusterInstancetype",
        name: itName,
      };
      clearInlineDomainResources(body);
    } else {
      const cpuCores = input.spec.cpuCores ?? 0;
      const memory = input.spec.memory?.trim() ?? "";
      if (!Number.isFinite(cpuCores) || cpuCores < 1) {
        throw new Error("cpuCores must be a positive number");
      }
      if (!memory) throw new Error("memory is required in manual size mode");
      delete body.spec.instancetype;
      applyManualDomainResources(body, cpuCores, memory);
    }

    const preference = input.spec.preference?.trim();
    if (preference) {
      body.spec.preference = {
        kind: "VirtualMachineClusterPreference",
        name: preference,
      };
    } else {
      delete body.spec.preference;
    }
  }

  try {
    await custom.replaceNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace: input.namespace,
      plural: "virtualmachines",
      name: input.name,
      body,
    });
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }

  return getVm(input.cluster, input.namespace, input.name);
}

function ensureTemplateDomain(vm: KubeVm): {
  cpu?: { cores?: number; threads?: number; sockets?: number };
  resources?: {
    requests?: { memory?: string; cpu?: string };
    limits?: { memory?: string; cpu?: string };
  };
} {
  vm.spec = vm.spec ?? {};
  vm.spec.template = vm.spec.template ?? {};
  vm.spec.template.spec = vm.spec.template.spec ?? {};
  vm.spec.template.spec.domain = vm.spec.template.spec.domain ?? {};
  return vm.spec.template.spec.domain;
}

function clearInlineDomainResources(vm: KubeVm): void {
  const domain = ensureTemplateDomain(vm);
  delete domain.cpu;
  if (domain.resources?.requests) {
    delete domain.resources.requests.memory;
    delete domain.resources.requests.cpu;
    if (Object.keys(domain.resources.requests).length === 0) {
      delete domain.resources.requests;
    }
  }
  if (domain.resources?.limits) {
    delete domain.resources.limits.memory;
    delete domain.resources.limits.cpu;
    if (Object.keys(domain.resources.limits).length === 0) {
      delete domain.resources.limits;
    }
  }
  if (domain.resources && Object.keys(domain.resources).length === 0) {
    delete domain.resources;
  }
}

function applyManualDomainResources(vm: KubeVm, cpuCores: number, memory: string): void {
  const domain = ensureTemplateDomain(vm);
  domain.cpu = { cores: cpuCores };
  domain.resources = domain.resources ?? {};
  domain.resources.requests = {
    ...(domain.resources.requests ?? {}),
    memory,
  };
}

type VmPowerAction = "start" | "stop" | "restart";
type VmiPauseAction = "pause" | "unpause";

async function putVmSubresource(
  cluster: ClusterId,
  namespace: string,
  name: string,
  action: VmPowerAction,
): Promise<void> {
  const { kc } = getClusterClients(cluster);
  const path = `/apis/subresources.kubevirt.io/v1/namespaces/${encodeURIComponent(namespace)}/virtualmachines/${encodeURIComponent(name)}/${action}`;
  const res = await k8sFetch(kc, path, {
    method: "PUT",
    body: "{}",
  });
  if (!res.ok) {
    const text = await res.text();
    // Fallback: patch runStrategy / running for older clusters (start/stop only)
    if (
      (action === "start" || action === "stop") &&
      (res.status === 404 || res.status === 405)
    ) {
      await patchPowerState(cluster, namespace, name, action === "start");
      return;
    }
    throw new Error(httpErrorMessage(res.status, text));
  }
}

/** Pause/unpause target the VMI (virtctl does the same under the hood). */
async function putVmiSubresource(
  cluster: ClusterId,
  namespace: string,
  name: string,
  action: VmiPauseAction,
): Promise<void> {
  const { kc } = getClusterClients(cluster);
  const path = `/apis/subresources.kubevirt.io/v1/namespaces/${encodeURIComponent(namespace)}/virtualmachineinstances/${encodeURIComponent(name)}/${action}`;
  const res = await k8sFetch(kc, path, {
    method: "PUT",
    body: "{}",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(httpErrorMessage(res.status, text));
  }
}

/**
 * Fallback when start/stop subresources are unavailable: set runStrategy only.
 * Never writes the deprecated `spec.running` boolean.
 */
async function patchPowerState(
  cluster: ClusterId,
  namespace: string,
  name: string,
  start: boolean,
): Promise<void> {
  const { custom } = getClusterClients(cluster);
  const existing = (await custom.getNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace,
    plural: "virtualmachines",
    name,
  })) as KubeVm;

  const nextSpec: Record<string, unknown> = {
    ...(existing.spec as Record<string, unknown> | undefined),
    runStrategy: start ? "Always" : "Halted",
  };
  // Deprecated boolean conflicts with runStrategy on modern KubeVirt.
  delete nextSpec.running;

  const body = {
    ...existing,
    spec: nextSpec,
  };

  await custom.replaceNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace,
    plural: "virtualmachines",
    name,
    body,
  });
}

export async function stopVm(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  await putVmSubresource(cluster, namespace, name, "stop");
}

export async function startVm(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  await putVmSubresource(cluster, namespace, name, "start");
}

export async function restartVm(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  await putVmSubresource(cluster, namespace, name, "restart");
}

/**
 * ACPI soft reboot via the VMI softreboot subresource (guest-initiated reboot).
 * Prefer when the guest agent is connected; hard restart if the guest is stuck.
 */
export async function softRebootVm(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  const { kc } = getClusterClients(cluster);
  const path = `/apis/subresources.kubevirt.io/v1/namespaces/${encodeURIComponent(namespace)}/virtualmachineinstances/${encodeURIComponent(name)}/softreboot`;
  const res = await k8sFetch(kc, path, {
    method: "PUT",
    body: "{}",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(httpErrorMessage(res.status, text));
  }
}

export async function pauseVm(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  await putVmiSubresource(cluster, namespace, name, "pause");
}

export async function unpauseVm(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  await putVmiSubresource(cluster, namespace, name, "unpause");
}

export type DeleteVmOptions = {
  /**
   * When true, delete the VirtualMachine only; leave referenced root
   * DataVolumes in place (stamp retained-from-vm labels).
   * When false (default), delete the VM then explicitly delete those DVs.
   *
   * kmc creates root disks as standalone DVs (not dataVolumeTemplates), so
   * cascade alone does not remove them — destroy path must delete DVs.
   * Legacy template-owned DVs still cascade; we also try explicit delete (404 ok).
   */
  retainDisks?: boolean;
};

/** Returned so UI can toast retained disk names. */
export type DeleteVmResult = {
  retainedDisks: string[];
};

/**
 * CDI phases accepted for root-disk reuse. Shared by createVm + picker API.
 * Re-exported from constants for call-site convenience.
 */
export { REUSABLE_DV_PHASES };

type KubeDataVolumeForRetain = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: Array<{
      kind?: string;
      name?: string;
      uid?: string;
      apiVersion?: string;
      controller?: boolean;
      blockOwnerDeletion?: boolean;
    }>;
    [key: string]: unknown;
  };
  spec?: {
    storage?: {
      resources?: { requests?: { storage?: string } };
    };
    pvc?: {
      resources?: { requests?: { storage?: string } };
    };
  };
  status?: {
    phase?: string;
    claimName?: string;
    conditions?: Array<{ type?: string; status?: string }>;
  };
};

function isConflictError(err: unknown): boolean {
  const e = err as {
    statusCode?: number;
    code?: number | string;
    response?: { statusCode?: number; status?: number };
  };
  const n =
    e?.statusCode ??
    e?.response?.statusCode ??
    e?.response?.status ??
    (typeof e?.code === "number" ? e.code : undefined);
  if (n === 409) return true;
  const msg = formatError(err).toLowerCase();
  return msg.includes("409") || msg.includes("conflict");
}

function isNotFoundError(err: unknown): boolean {
  const e = err as {
    statusCode?: number;
    response?: { statusCode?: number; status?: number };
  };
  const n = e?.statusCode ?? e?.response?.statusCode ?? e?.response?.status;
  if (n === 404) return true;
  const msg = formatError(err).toLowerCase();
  return msg.includes("404") || msg.includes("not found");
}

/** Collect unique DataVolume names from volumes + dataVolumeTemplates. */
export function collectVmDataVolumeNames(vm: KubeVm): string[] {
  const names = new Set<string>();
  for (const vol of vm.spec?.template?.spec?.volumes ?? []) {
    const n = vol.dataVolume?.name?.trim();
    if (n) names.add(n);
  }
  for (const tpl of vm.spec?.dataVolumeTemplates ?? []) {
    const n = tpl.metadata?.name?.trim();
    if (n) names.add(n);
  }
  return Array.from(names);
}

function dataVolumeOwnedByVm(
  owners: NonNullable<KubeDataVolumeForRetain["metadata"]>["ownerReferences"],
  vmName: string,
  vmUid: string | undefined,
): boolean {
  return (owners ?? []).some(
    (o) =>
      o.kind === "VirtualMachine" &&
      o.name === vmName &&
      (o.uid == null || vmUid == null || o.uid === vmUid),
  );
}

/**
 * GET + replace: clear ownerReferences, stamp retain labels, drop kubevirt.io/vm.
 * Prefer omitting status (CRD status subresource). Single 409 retry.
 */
async function detachDataVolumeFromVm(opts: {
  custom: ReturnType<typeof getClusterClients>["custom"];
  namespace: string;
  dvName: string;
  vmName: string;
  vmUid: string;
}): Promise<boolean> {
  const { custom, namespace, dvName, vmName, vmUid } = opts;

  const attempt = async (): Promise<boolean> => {
    let dv: KubeDataVolumeForRetain;
    try {
      dv = (await custom.getNamespacedCustomObject({
        group: "cdi.kubevirt.io",
        version: "v1beta1",
        namespace,
        plural: "datavolumes",
        name: dvName,
      })) as KubeDataVolumeForRetain;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }

    if (!dataVolumeOwnedByVm(dv.metadata?.ownerReferences, vmName, vmUid)) {
      return false;
    }

    const { ownerReferences: _drop, ...metaRest } = dv.metadata ?? {};
    void _drop;

    const nextLabels: Record<string, string> = {
      ...(dv.metadata?.labels ?? {}),
      [KMC_LABEL_RETAINED_FROM_VM]: vmName,
      [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    };
    delete nextLabels["kubevirt.io/vm"];

    await custom.replaceNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      name: dvName,
      body: {
        apiVersion: dv.apiVersion ?? "cdi.kubevirt.io/v1beta1",
        kind: dv.kind ?? "DataVolume",
        metadata: {
          ...metaRest,
          name: dvName,
          namespace,
          resourceVersion: dv.metadata?.resourceVersion,
          ownerReferences: [],
          labels: nextLabels,
          annotations: {
            ...(dv.metadata?.annotations ?? {}),
            [KMC_ANN_RETAINED_AT]: new Date().toISOString(),
          },
        },
        spec: dv.spec,
        // Omit status — prefer metadata+spec only for CRD status subresource.
      },
    });
    return true;
  };

  try {
    return await attempt();
  } catch (err) {
    if (!isConflictError(err)) throw err;
    return await attempt();
  }
}

/**
 * Validate a same-namespace DataVolume can be used as a new VM root disk.
 */
export async function assertDataVolumeReusable(opts: {
  cluster: ClusterId;
  namespace: string;
  dataVolumeName: string;
}): Promise<{ phase: string; size?: string; claimName?: string }> {
  const { cluster, namespace, dataVolumeName } = opts;
  const { custom } = getClusterClients(cluster);

  let dv: KubeDataVolumeForRetain;
  try {
    dv = (await custom.getNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      name: dataVolumeName,
    })) as KubeDataVolumeForRetain;
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(`DataVolume not found: ${namespace}/${dataVolumeName}`);
    }
    throw new Error(formatError(err), { cause: err });
  }

  const phase = dv.status?.phase ?? "";
  if (!(REUSABLE_DV_PHASES as readonly string[]).includes(phase)) {
    throw new Error(
      `DataVolume ${dataVolumeName} is not reusable (phase=${phase || "unknown"}; need ${REUSABLE_DV_PHASES.join(" or ")})`,
    );
  }

  const readyFalse = (dv.status?.conditions ?? []).some(
    (c) => c.type === "Ready" && c.status === "False",
  );
  if (readyFalse) {
    throw new Error(
      `DataVolume ${dataVolumeName} is not Ready (Ready condition is False)`,
    );
  }

  const claimName = dv.status?.claimName?.trim() || dataVolumeName;

  // Refuse if still owned by a live VirtualMachine.
  for (const o of dv.metadata?.ownerReferences ?? []) {
    if (o.kind !== "VirtualMachine" || !o.name) continue;
    try {
      await custom.getNamespacedCustomObject({
        group: "kubevirt.io",
        version: "v1",
        namespace,
        plural: "virtualmachines",
        name: o.name,
      });
      throw new Error(
        `DataVolume is still owned by VirtualMachine ${o.name}`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("still owned")) throw err;
      if (!isNotFoundError(err)) {
        throw new Error(formatError(err), { cause: err });
      }
      // owner VM gone — ok
    }
  }

  // In-use scan: any VM in the namespace that references this DV, its PVC, or
  // a dataVolumeTemplate with the same name.
  const vmList = (await custom.listNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace,
    plural: "virtualmachines",
  })) as { items?: KubeVm[] };

  for (const vm of vmList.items ?? []) {
    const vmName = vm.metadata?.name ?? "unknown";
    for (const vol of vm.spec?.template?.spec?.volumes ?? []) {
      if (vol.dataVolume?.name === dataVolumeName) {
        throw new Error(
          `DataVolume is still attached to VirtualMachine ${vmName} (volume ${vol.name ?? dataVolumeName}). Detach it there first, or wait for the VM spec to refresh.`,
        );
      }
      const pvc = vol.persistentVolumeClaim?.claimName;
      if (pvc && (pvc === claimName || pvc === dataVolumeName)) {
        throw new Error(
          `DataVolume backing PVC is still attached to VirtualMachine ${vmName}`,
        );
      }
    }
    for (const tpl of vm.spec?.dataVolumeTemplates ?? []) {
      if (tpl.metadata?.name === dataVolumeName) {
        throw new Error(
          `DataVolume is still referenced by VirtualMachine ${vmName} dataVolumeTemplate`,
        );
      }
    }
  }

  const size =
    dv.spec?.storage?.resources?.requests?.storage ??
    dv.spec?.pvc?.resources?.requests?.storage;

  return { phase, size, claimName };
}

/**
 * After re-attaching a retained/standalone DV, clear retain labels and stamp
 * kubevirt.io/vm for the new owner. Best-effort (non-fatal).
 */
async function stampDataVolumeAttachedToVm(opts: {
  cluster: ClusterId;
  namespace: string;
  dvName: string;
  vmName: string;
}): Promise<void> {
  const { custom } = getClusterClients(opts.cluster);
  try {
    const dv = (await custom.getNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace: opts.namespace,
      plural: "datavolumes",
      name: opts.dvName,
    })) as KubeDataVolumeForRetain;

    const labels: Record<string, string> = {
      ...(dv.metadata?.labels ?? {}),
      [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
      "kubevirt.io/vm": opts.vmName,
    };
    delete labels[KMC_LABEL_RETAINED_FROM_VM];
    const annotations = { ...(dv.metadata?.annotations ?? {}) };
    delete annotations[KMC_ANN_RETAINED_AT];

    await custom.replaceNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace: opts.namespace,
      plural: "datavolumes",
      name: opts.dvName,
      body: {
        apiVersion: dv.apiVersion ?? "cdi.kubevirt.io/v1beta1",
        kind: dv.kind ?? "DataVolume",
        metadata: {
          name: opts.dvName,
          namespace: opts.namespace,
          resourceVersion: dv.metadata?.resourceVersion,
          uid: dv.metadata?.uid,
          labels,
          annotations,
          ownerReferences: dv.metadata?.ownerReferences,
        },
        spec: dv.spec,
      },
    });
  } catch {
    /* ignore — attach already succeeded */
  }
}

export async function deleteVm(
  cluster: ClusterId,
  namespace: string,
  name: string,
  opts?: DeleteVmOptions,
): Promise<DeleteVmResult> {
  const retainDisks = opts?.retainDisks === true;
  const retainedDisks: string[] = [];
  const { custom } = getClusterClients(cluster);

  let vm: KubeVm | null = null;
  try {
    vm = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name,
    })) as KubeVm;
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(`Virtual machine not found: ${namespace}/${name}`);
    }
    throw new Error(formatError(err), { cause: err });
  }

  const candidates = collectVmDataVolumeNames(vm);
  const vmUid = vm.metadata?.uid ?? "";

  if (retainDisks) {
    // Legacy: strip ownerRefs if any template-owned DVs remain.
    // Standalone DVs: just stamp retained labels.
    for (const dvName of candidates) {
      try {
        const detached = await detachDataVolumeFromVm({
          custom,
          namespace,
          dvName,
          vmName: name,
          vmUid,
        });
        if (detached) {
          retainedDisks.push(dvName);
          continue;
        }
        // Not owned (standalone kmc disk) — still mark retained if present
        const stamped = await stampRetainedDataVolume({
          custom,
          namespace,
          dvName,
          vmName: name,
        });
        if (stamped) retainedDisks.push(dvName);
      } catch (err) {
        throw new Error(
          `Failed to prepare DataVolume ${dvName} for retain: ${formatError(err)}. VM was not deleted.`,
          { cause: err },
        );
      }
    }
    console.warn(
      `deleteVm retainDisks: ${cluster}/${namespace}/${name} → [${retainedDisks.join(", ")}]`,
    );
  }

  // Free IPAddress CRs (DHCP leases project from these).
  try {
    const ann = vm.metadata?.annotations?.[IPAM_ANNOTATION_IPV4];
    const addrs = ann ? parseIpv4AnnotationList(ann) : [];
    await deleteIpAddressClaimsForVm(cluster, namespace, name, addrs);
  } catch (err) {
    console.error("deleteIpAddressClaimsForVm:", formatError(err));
  }

  try {
    await custom.deleteNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name,
    });
  } catch (err) {
    if (retainDisks && retainedDisks.length > 0) {
      throw new Error(
        `Failed to delete VirtualMachine ${name} after retaining disks [${retainedDisks.join(", ")}]: ${formatError(err)}. ` +
          `DataVolumes may still be present; check Data Volumes before retrying.`,
        { cause: err },
      );
    }
    throw new Error(formatError(err), { cause: err });
  }

  // Destroy disks: standalone DVs do not cascade with the VM — delete explicitly.
  // Template-owned DVs may already be gone (cascade); 404 is fine.
  if (!retainDisks && candidates.length > 0) {
    for (const dvName of candidates) {
      try {
        await deleteDataVolumeRaw(cluster, namespace, dvName);
      } catch (err) {
        console.error(
          `deleteVm: failed to delete DataVolume ${namespace}/${dvName}:`,
          formatError(err),
        );
      }
    }
  }

  return { retainedDisks };
}

/**
 * Stamp retain labels on a standalone (unowned) DataVolume without clearing owners.
 * Returns false if the DV is missing.
 */
async function stampRetainedDataVolume(opts: {
  custom: ReturnType<typeof getClusterClients>["custom"];
  namespace: string;
  dvName: string;
  vmName: string;
}): Promise<boolean> {
  const { custom, namespace, dvName, vmName } = opts;
  const attempt = async (): Promise<boolean> => {
    let dv: KubeDataVolumeForRetain;
    try {
      dv = (await custom.getNamespacedCustomObject({
        group: "cdi.kubevirt.io",
        version: "v1beta1",
        namespace,
        plural: "datavolumes",
        name: dvName,
      })) as KubeDataVolumeForRetain;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }

    // Already has retain label — count as retained
    if (dv.metadata?.labels?.[KMC_LABEL_RETAINED_FROM_VM]) {
      return true;
    }

    const { ownerReferences: owners, ...metaRest } = dv.metadata ?? {};
    const nextLabels: Record<string, string> = {
      ...(dv.metadata?.labels ?? {}),
      [KMC_LABEL_RETAINED_FROM_VM]: vmName,
      [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    };
    delete nextLabels["kubevirt.io/vm"];

    await custom.replaceNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      name: dvName,
      body: {
        apiVersion: dv.apiVersion ?? "cdi.kubevirt.io/v1beta1",
        kind: dv.kind ?? "DataVolume",
        metadata: {
          ...metaRest,
          name: dvName,
          namespace,
          resourceVersion: dv.metadata?.resourceVersion,
          // Preserve owners if any (standalone should be empty)
          ownerReferences: owners ?? [],
          labels: nextLabels,
          annotations: {
            ...(dv.metadata?.annotations ?? {}),
            [KMC_ANN_RETAINED_AT]: new Date().toISOString(),
          },
        },
        spec: dv.spec,
      },
    });
    return true;
  };

  try {
    return await attempt();
  } catch (err) {
    if (!isConflictError(err)) throw err;
    return await attempt();
  }
}
