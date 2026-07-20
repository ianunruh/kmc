import type {
  ClusterId,
  ClusterInfo,
  CreateVmRequest,
  VmDetail,
  VmNetworkInfo,
  VmSummary,
  VmVolumeInfo,
} from "~/lib/types";
import {
  getClusterClients,
  getConfiguredContexts,
  httpErrorMessage,
  k8sFetch,
} from "./clients.server";
import { buildVirtualMachineManifest } from "./template.server";

interface KubeVm {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    running?: boolean;
    runStrategy?: string;
    instancetype?: { name?: string; kind?: string };
    preference?: { name?: string; kind?: string };
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
  };
}

interface KubeVmi {
  status?: {
    phase?: string;
    nodeName?: string;
    interfaces?: Array<{
      name?: string;
      mac?: string;
      ipAddress?: string;
      ipAddresses?: string[];
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

function mapVm(cluster: ClusterId, vm: KubeVm): VmSummary {
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

  const cores = vm.spec?.template?.spec?.domain?.cpu?.cores;
  const memory =
    vm.spec?.template?.spec?.domain?.resources?.requests?.memory ??
    vm.spec?.template?.spec?.domain?.resources?.limits?.memory;
  const instanceType = vm.spec?.instancetype?.name;

  const dv = vm.spec?.dataVolumeTemplates?.[0];
  const disk =
    dv?.spec?.storage?.resources?.requests?.storage ??
    dv?.spec?.pvc?.resources?.requests?.storage;

  const notReady = vm.status?.conditions?.find(
    (c) => c.type === "Ready" && c.status !== "True",
  );

  return {
    cluster,
    namespace,
    name,
    status,
    ready,
    running,
    cpu: instanceType
      ? instanceType
      : cores != null
        ? `${cores}c`
        : undefined,
    memory: instanceType ? undefined : memory,
    disk,
    age: vm.metadata?.creationTimestamp ?? "",
    nodeName: vm.status?.nodeName,
    message: notReady?.message ?? notReady?.reason,
  };
}

function mapVolumes(vm: KubeVm): VmVolumeInfo[] {
  const disks = vm.spec?.template?.spec?.domain?.devices?.disks ?? [];
  const diskByName = new Map(
    disks.map((d) => [d.name ?? "", d] as const),
  );
  const dvTemplates = new Map(
    (vm.spec?.dataVolumeTemplates ?? []).map((dv) => [
      dv.metadata?.name ?? "",
      dv,
    ]),
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
        tpl?.spec?.storage?.storageClassName ??
        tpl?.spec?.pvc?.storageClassName;
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
      };
    }
    if (vol.persistentVolumeClaim?.claimName) {
      return {
        name: vol.name ?? "",
        kind: "PVC",
        detail: vol.persistentVolumeClaim.claimName,
        diskBus: bus,
      };
    }
    if (vol.cloudInitNoCloud) {
      return {
        name: vol.name ?? "",
        kind: "cloudInitNoCloud",
        detail: vol.cloudInitNoCloud.networkData
          ? "userData + networkData"
          : "userData",
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
    const ips =
      st?.ipAddresses ??
      (st?.ipAddress ? [st.ipAddress] : undefined);
    return {
      name: net.name ?? "",
      model: iface?.model,
      multusNetworkName: net.multus?.networkName,
      pod: net.pod != null,
      mac: st?.mac ?? iface?.macAddress,
      ipAddresses: ips,
    };
  });
}

function mapVmDetail(
  cluster: ClusterId,
  vm: KubeVm,
  vmi?: KubeVmi | null,
): VmDetail {
  const summary = mapVm(cluster, vm);
  const annotations = vm.metadata?.annotations ?? {};
  const ipv4 =
    annotations["monsoon.ianunruh.com/ipv4Address"] ??
    vmi?.status?.interfaces?.flatMap((i) => i.ipAddresses ?? (i.ipAddress ? [i.ipAddress] : []))?.[0];

  return {
    ...summary,
    uid: vm.metadata?.uid,
    nodeName: vmi?.status?.nodeName ?? summary.nodeName,
    runStrategy: vm.spec?.runStrategy,
    instanceType: vm.spec?.instancetype?.name,
    preference: vm.spec?.preference?.name,
    machineType: vm.spec?.template?.spec?.domain?.machine?.type,
    architecture: vm.spec?.template?.spec?.architecture,
    labels: vm.metadata?.labels ?? {},
    annotations,
    conditions: (vm.status?.conditions ?? []).map((c) => ({
      type: c.type ?? "Unknown",
      status: c.status ?? "Unknown",
      reason: c.reason,
      message: c.message,
      lastTransitionTime: c.lastTransitionTime,
    })),
    volumes: mapVolumes(vm),
    networks: mapNetworks(vm, vmi),
    ipv4Address: ipv4,
    vmiPhase: vmi?.status?.phase,
    hasVmi: vmi != null,
  };
}

export async function getVm(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<VmDetail> {
  const { custom } = getClusterClients(cluster);

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

  return mapVmDetail(cluster, vm, vmi);
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
  const contexts = clusterFilter
    ? [clusterFilter]
    : getConfiguredContexts();

  const clusters = await Promise.all(contexts.map(probeCluster));
  const items: VmSummary[] = [];

  await Promise.all(
    clusters.map(async (cluster) => {
      if (!cluster.reachable) return;
      try {
        const { custom } = getClusterClients(cluster.id);
        const res = (await custom.listClusterCustomObject({
          group: "kubevirt.io",
          version: "v1",
          plural: "virtualmachines",
        })) as { items?: KubeVm[] };

        for (const vm of res.items ?? []) {
          items.push(mapVm(cluster.id, vm));
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

  const { custom } = getClusterClients(input.cluster);
  const body = buildVirtualMachineManifest(input);

  try {
    const created = (await custom.createNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace: input.namespace,
      plural: "virtualmachines",
      body,
    })) as KubeVm;
    return mapVm(input.cluster, created);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message);
  }
}

async function putVmSubresource(
  cluster: ClusterId,
  namespace: string,
  name: string,
  action: "start" | "stop",
): Promise<void> {
  const { kc } = getClusterClients(cluster);
  const path = `/apis/subresources.kubevirt.io/v1/namespaces/${encodeURIComponent(namespace)}/virtualmachines/${encodeURIComponent(name)}/${action}`;
  const res = await k8sFetch(kc, path, {
    method: "PUT",
    body: "{}",
  });
  if (!res.ok) {
    const text = await res.text();
    // Fallback: patch runStrategy / running for older clusters
    if (res.status === 404 || res.status === 405) {
      await patchPowerState(cluster, namespace, name, action === "start");
      return;
    }
    throw new Error(httpErrorMessage(res.status, text));
  }
}

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

  const body: Record<string, unknown> = {
    ...existing,
    spec: {
      ...existing.spec,
      runStrategy: start ? "Always" : "Halted",
      running: start,
    },
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
