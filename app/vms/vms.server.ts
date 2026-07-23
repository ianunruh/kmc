import { formatError } from "~/lib/errors";
import { canEditVmSpec } from "~/lib/format";
import type {
  ClusterId,
  ClusterInfo,
  CreateVmRequest,
  UpdateVmRequest,
  VmDetail,
  VmGuestAgentInfo,
  VmGuestFilesystem,
  VmNetworkInfo,
  VmSummary,
  VmVolumeInfo,
} from "~/lib/types";
import { VM_RUN_STRATEGIES } from "~/lib/types";
import {
  getClusterClients,
  getConfiguredContexts,
  httpErrorMessage,
  k8sFetch,
} from "~/lib/k8s/clients.server";
import type { KubeConfig } from "@kubernetes/client-node";
import { assertVmNamespaceAllowed } from "~/lib/k8s/catalog.server";
import { ensureStaticMultusNads } from "~/lib/k8s/static-nads.server";
import {
  allocateIpv4ForMultus,
  parseMultusNetworkRef,
} from "~/lib/ipam/pools.server";
import { IPAM_ANNOTATION_IPV4 } from "~/lib/ipam/constants";
import {
  KMC_LABEL_RESOURCE,
  KMC_LABEL_VLAN,
  KMC_MANAGED_BY,
  KMC_RESOURCE_NETWORK,
  KMC_RESOURCE_VPC,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import { addressFromIpv4Annotation } from "~/lib/ipam/cidr";
import { parseIpv4AnnotationList } from "~/lib/ipam/pools.server";
import { listFloatingIpsFromPolicies } from "~/vpcs/nat-policy.server";
import {
  bindAllocationsToNetworks,
  buildVirtualMachineManifest,
  multusNetworksFromRequest,
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
          dataVolume?: { name?: string };
          persistentVolumeClaim?: { claimName?: string };
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
  };
}

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

  const dv = vm.spec?.dataVolumeTemplates?.[0];
  const disk =
    dv?.spec?.storage?.resources?.requests?.storage ??
    dv?.spec?.pvc?.resources?.requests?.storage;

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

function mapVolumes(vm: KubeVm): VmVolumeInfo[] {
  const disks = vm.spec?.template?.spec?.domain?.devices?.disks ?? [];
  const diskByName = new Map(disks.map((d) => [d.name ?? "", d] as const));
  const dvTemplates = new Map(
    (vm.spec?.dataVolumeTemplates ?? []).map((dv) => [dv.metadata?.name ?? "", dv]),
  );

  return (vm.spec?.template?.spec?.volumes ?? []).map((vol) => {
    const disk = diskByName.get(vol.name ?? "");
    const bus = disk?.disk?.bus ?? disk?.cdrom?.bus;
    if (vol.dataVolume?.name) {
      const tpl = dvTemplates.get(vol.dataVolume.name);
      const size =
        tpl?.spec?.storage?.resources?.requests?.storage ??
        tpl?.spec?.pvc?.resources?.requests?.storage;
      const storageClass =
        tpl?.spec?.storage?.storageClassName ?? tpl?.spec?.pvc?.storageClassName;
      const src = tpl?.spec?.source?.pvc
        ? `clone ${tpl.spec.source.pvc.namespace}/${tpl.spec.source.pvc.name}`
        : tpl?.spec?.source?.http?.url
          ? `http ${tpl.spec.source.http.url}`
          : tpl?.spec?.source?.blank
            ? "blank"
            : vol.dataVolume.name;
      return {
        name: vol.name ?? "",
        kind: "DataVolume",
        detail: src,
        diskBus: bus,
        size,
        storageClass,
        linkName: vol.dataVolume.name,
      };
    }
    if (vol.persistentVolumeClaim?.claimName) {
      return {
        name: vol.name ?? "",
        kind: "PVC",
        detail: vol.persistentVolumeClaim.claimName,
        diskBus: bus,
        // CDI often backs a DV of the same name; link to DV detail when possible.
        linkName: vol.persistentVolumeClaim.claimName,
      };
    }
    if (vol.cloudInitNoCloud) {
      return {
        name: vol.name ?? "",
        kind: "cloudInitNoCloud",
        detail: vol.cloudInitNoCloud.networkData ? "userData + networkData" : "userData",
        diskBus: bus,
      };
    }
    if (vol.containerDisk?.image) {
      return {
        name: vol.name ?? "",
        kind: "containerDisk",
        detail: vol.containerDisk.image,
        diskBus: bus,
      };
    }
    return {
      name: vol.name ?? "unknown",
      kind: "other",
      diskBus: bus,
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

function mapVmDetail(
  cluster: ClusterId,
  vm: KubeVm,
  vmi?: KubeVmi | null,
  instanceTypes?: Map<string, InstanceTypeSize>,
  guestOsInfo?: GuestOsInfoSubresource | null,
): VmDetail {
  const summary = mapVm(cluster, vm, instanceTypes);
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
    volumes: mapVolumes(vm),
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

  const [instanceTypes, guestOsInfo] = await Promise.all([
    loadInstanceTypeSizes(cluster),
    agentConnected ? fetchGuestOsInfo(kc, namespace, name) : Promise.resolve(null),
  ]);
  const detail = mapVmDetail(cluster, vm, vmi, instanceTypes, guestOsInfo);
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
        const { custom } = getClusterClients(id);
        const [res, instanceTypes, floats] = await Promise.all([
          custom.listClusterCustomObject({
            group: "kubevirt.io",
            version: "v1",
            plural: "virtualmachines",
          }) as Promise<{ items?: KubeVm[] }>,
          loadInstanceTypeSizes(id),
          listFloatingIpsFromPolicies(id).catch(() => []),
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
          const publicAddr =
            addressFromIpv4Annotation(f.public) ?? f.public.trim();
          if (!publicAddr) continue;
          let key: string | undefined;
          if (f.targetVm?.trim()) {
            key = `${f.namespace}/${f.targetVm.trim()}`;
          } else {
            const priv = addressFromIpv4Annotation(f.private) ?? f.private.trim();
            if (priv) key = privateToVmKey.get(`${f.namespace}|${priv}`);
          }
          if (!key) continue;
          const list = floatsByVmKey.get(key) ?? [];
          if (!list.includes(publicAddr)) list.push(publicAddr);
          floatsByVmKey.set(key, list);
        }

        for (const vm of res.items ?? []) {
          const summary = mapVm(id, vm, instanceTypes);
          const key = `${summary.namespace}/${summary.name}`;
          const floatingIpv4 = floatsByVmKey.get(key);
          if (floatingIpv4?.length) {
            summary.floatingIpv4 = floatingIpv4;
          }
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

export async function createVm(input: CreateVmRequest): Promise<VmSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!input.sshPublicKey?.trim()) throw new Error("sshPublicKey is required");
  if (!input.diskSize?.trim()) throw new Error("diskSize is required");
  if (!input.image?.name?.trim()) throw new Error("image is required");

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

  // Materialize shared Multus NADs (e.g. external) from ipPools.cni when missing.
  await ensureStaticMultusNads(input.cluster, input.namespace, multusNames);

  const { custom } = getClusterClients(input.cluster);

  // Sequential so multi-attach can reserve prior picks via extraUsed when
  // two NADs resolve to the same pool (or we add more attachments later).
  const rawAllocations: Array<Awaited<ReturnType<typeof allocateIpv4ForMultus>>> =
    [];
  const extraUsed: string[] = [];
  for (const name of multusNames) {
    const alloc = await allocateIpv4ForMultus(
      input.cluster,
      name,
      input.namespace,
      { extraUsed },
    );
    rawAllocations.push(alloc);
    if (alloc) extraUsed.push(alloc.address);
  }
  const allocations = bindAllocationsToNetworks(multusNames, rawAllocations);

  const body = buildVirtualMachineManifest(input, allocations);

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
    return mapVm(input.cluster, created, instanceTypes);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
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

export async function deleteVm(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  const { custom } = getClusterClients(cluster);
  await custom.deleteNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace,
    plural: "virtualmachines",
    name,
  });
}
