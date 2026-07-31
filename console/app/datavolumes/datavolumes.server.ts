import { formatError } from "~/lib/errors";
import type {
  ClusterId,
  CreateDataVolumeRequest,
  DataVolumeDetail,
  DataVolumeSummary,
} from "~/lib/types";
import {
  KMC_LABEL_RETAINED_FROM_VM,
  REUSABLE_DV_PHASES,
} from "~/lib/k8s/constants";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { getImageNamespace } from "~/lib/k8s/image-catalog.server";
import { listClusters } from "~/vms/vms.server";

interface KubeDataVolume {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: Array<{ kind?: string; name?: string }>;
  };
  spec?: {
    source?: {
      blank?: unknown;
      pvc?: { name?: string; namespace?: string };
      http?: { url?: string };
      registry?: { url?: string };
      s3?: { url?: string };
      gcs?: { url?: string };
      imageio?: unknown;
      vddk?: unknown;
      snapshot?: unknown;
    };
    pvc?: {
      accessModes?: string[];
      volumeMode?: string;
      storageClassName?: string;
      resources?: { requests?: { storage?: string } };
    };
    storage?: {
      accessModes?: string[];
      volumeMode?: string;
      storageClassName?: string;
      resources?: { requests?: { storage?: string } };
    };
  };
  status?: {
    phase?: string;
    progress?: string;
    claimName?: string;
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
      lastTransitionTime?: string;
      lastHeartbeatTime?: string;
    }>;
  };
}

function sourceInfo(dv: KubeDataVolume): { kind: string; detail?: string } {
  const src = dv.spec?.source;
  if (!src) return { kind: "unknown" };
  if (src.blank != null) return { kind: "blank" };
  if (src.pvc)
    return {
      kind: "pvc",
      detail: `${src.pvc.namespace ?? "?"}/${src.pvc.name ?? "?"}`,
    };
  if (src.http?.url) return { kind: "http", detail: src.http.url };
  if (src.registry?.url) return { kind: "registry", detail: src.registry.url };
  if (src.s3?.url) return { kind: "s3", detail: src.s3.url };
  if (src.gcs?.url) return { kind: "gcs", detail: src.gcs.url };
  if (src.snapshot != null) return { kind: "snapshot" };
  return { kind: "other" };
}

function mapSummary(cluster: ClusterId, dv: KubeDataVolume): DataVolumeSummary {
  const src = sourceInfo(dv);
  const size =
    dv.spec?.storage?.resources?.requests?.storage ??
    dv.spec?.pvc?.resources?.requests?.storage;
  const storageClass =
    dv.spec?.storage?.storageClassName ?? dv.spec?.pvc?.storageClassName;
  const running = dv.status?.conditions?.find((c) => c.type === "Running");
  const owner = dv.metadata?.ownerReferences?.[0];
  const retainedFromVm =
    dv.metadata?.labels?.[KMC_LABEL_RETAINED_FROM_VM]?.trim() || undefined;

  return {
    cluster,
    namespace: dv.metadata?.namespace ?? "default",
    name: dv.metadata?.name ?? "unknown",
    phase: dv.status?.phase ?? "Unknown",
    progress: dv.status?.progress,
    size,
    storageClass,
    sourceKind: src.kind,
    sourceDetail: src.detail,
    age: dv.metadata?.creationTimestamp ?? "",
    message: running?.message ?? running?.reason,
    ownerKind: owner?.kind,
    ownerName: owner?.name,
    retainedFromVm,
  };
}

function mapDetail(cluster: ClusterId, dv: KubeDataVolume): DataVolumeDetail {
  const summary = mapSummary(cluster, dv);
  return {
    ...summary,
    uid: dv.metadata?.uid,
    volumeMode: dv.spec?.storage?.volumeMode ?? dv.spec?.pvc?.volumeMode,
    accessModes: dv.spec?.storage?.accessModes ?? dv.spec?.pvc?.accessModes,
    claimName: dv.status?.claimName,
    labels: dv.metadata?.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(dv.metadata?.annotations ?? {}).filter(
        ([k]) =>
          !k.startsWith("cdi.kubevirt.io/storage.clone.token") &&
          !k.startsWith("cdi.kubevirt.io/storage.extended.clone.token") &&
          !k.startsWith("kubectl.kubernetes.io/"),
      ),
    ),
    conditions: (dv.status?.conditions ?? []).map((c) => ({
      type: c.type ?? "Unknown",
      status: c.status ?? "Unknown",
      reason: c.reason,
      message: c.message,
      lastTransitionTime: c.lastTransitionTime ?? c.lastHeartbeatTime,
    })),
  };
}

export async function listDataVolumes(clusterFilter?: ClusterId): Promise<{
  items: DataVolumeSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const contexts = clusterFilter ? [clusterFilter] : getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const items: DataVolumeSummary[] = [];
  // Golden images live under Images; exclude that namespace from this list.
  const imageNs = getImageNamespace();

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const { custom } = getClusterClients(id);
        const res = (await custom.listClusterCustomObject({
          group: "cdi.kubevirt.io",
          version: "v1beta1",
          plural: "datavolumes",
        })) as { items?: KubeDataVolume[] };
        for (const dv of res.items ?? []) {
          const ns = dv.metadata?.namespace ?? "";
          if (ns === imageNs) continue;
          items.push(mapSummary(id, dv));
        }
      } catch (err) {
        if (cluster) {
          cluster.reachable = false;
          cluster.error = formatError(err);
        }
      }
    }),
  );

  items.sort((a, b) => {
    const c = a.cluster.localeCompare(b.cluster);
    if (c) return c;
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    return a.name.localeCompare(b.name);
  });

  return { items, clusters };
}

type VmVolumeRef = {
  dataVolume?: { name?: string };
  persistentVolumeClaim?: { claimName?: string };
};

/**
 * Map DataVolume / PVC names → VirtualMachine names that reference them
 * (template volumes + dataVolumeTemplates). One list walk for pickers.
 */
export async function mapDataVolumeAttachmentsInNamespace(
  cluster: ClusterId,
  namespace: string,
): Promise<Map<string, string[]>> {
  const attached = new Map<string, string[]>();
  const add = (key: string | undefined, vmName: string) => {
    const k = key?.trim();
    if (!k) return;
    const list = attached.get(k) ?? [];
    if (!list.includes(vmName)) list.push(vmName);
    attached.set(k, list);
  };

  const { custom } = getClusterClients(cluster);
  try {
    const res = (await custom.listNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
    })) as {
      items?: Array<{
        metadata?: { name?: string };
        spec?: {
          dataVolumeTemplates?: Array<{ metadata?: { name?: string } }>;
          template?: {
            spec?: {
              volumes?: VmVolumeRef[];
            };
          };
        };
      }>;
    };
    for (const vm of res.items ?? []) {
      const vmName = vm.metadata?.name;
      if (!vmName) continue;
      for (const vol of vm.spec?.template?.spec?.volumes ?? []) {
        add(vol.dataVolume?.name, vmName);
        add(vol.persistentVolumeClaim?.claimName, vmName);
      }
      for (const tpl of vm.spec?.dataVolumeTemplates ?? []) {
        add(tpl.metadata?.name, vmName);
      }
    }
  } catch {
    return attached;
  }
  return attached;
}

/**
 * Find VirtualMachines in the namespace that attach this DataVolume (or its PVC).
 */
async function findAttachedVmNames(
  cluster: ClusterId,
  namespace: string,
  dataVolumeName: string,
  claimName?: string,
): Promise<string[]> {
  const map = await mapDataVolumeAttachmentsInNamespace(cluster, namespace);
  const names = new Set<string>();
  for (const n of map.get(dataVolumeName) ?? []) names.add(n);
  const claim = claimName?.trim();
  if (claim && claim !== dataVolumeName) {
    for (const n of map.get(claim) ?? []) names.add(n);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export async function getDataVolume(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<DataVolumeDetail> {
  const { custom } = getClusterClients(cluster);
  try {
    const dv = (await custom.getNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      name,
    })) as KubeDataVolume;
    const detail = mapDetail(cluster, dv);
    const attachedVms = await findAttachedVmNames(
      cluster,
      namespace,
      name,
      detail.claimName,
    );
    return {
      ...detail,
      attachedVms: attachedVms.length > 0 ? attachedVms : undefined,
    };
  } catch (err) {
    const message = formatError(err);
    if (message.includes("404") || message.toLowerCase().includes("not found")) {
      throw new Response("DataVolume not found", { status: 404 });
    }
    throw new Error(message, { cause: err });
  }
}

export async function createDataVolume(
  input: CreateDataVolumeRequest,
): Promise<DataVolumeSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!input.size?.trim()) throw new Error("size is required");

  let source: Record<string, unknown>;
  switch (input.source.kind) {
    case "blank":
      source = { blank: {} };
      break;
    case "pvc":
      if (!input.source.pvcName?.trim()) throw new Error("source PVC name is required");
      source = {
        pvc: {
          name: input.source.pvcName,
          namespace: input.source.pvcNamespace || "vm-images",
        },
      };
      break;
    case "http":
      if (!input.source.url?.trim()) throw new Error("source URL is required");
      source = { http: { url: input.source.url } };
      break;
    default:
      throw new Error(`Unsupported source kind: ${input.source.kind}`);
  }

  const body = {
    apiVersion: "cdi.kubevirt.io/v1beta1",
    kind: "DataVolume",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: {
        "app.kubernetes.io/managed-by": "kmc",
        ...(input.labels ?? {}),
      },
    },
    spec: {
      source,
      // CDI `storage` (not legacy `pvc`) — StorageProfile can fill omitted fields.
      storage: {
        accessModes: ["ReadWriteOnce"],
        volumeMode: input.volumeMode ?? "Block",
        resources: {
          requests: {
            storage: input.size,
          },
        },
        ...(input.storageClass ? { storageClassName: input.storageClass } : {}),
      },
    },
  };

  const { custom } = getClusterClients(input.cluster);
  try {
    const created = (await custom.createNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace: input.namespace,
      plural: "datavolumes",
      body,
    })) as KubeDataVolume;
    return mapSummary(input.cluster, created);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export async function deleteDataVolume(
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
    throw new Error(formatError(err), { cause: err });
  }
}

/** Namespaced DataVolume list (prefer over cluster-wide list for pickers). */
export async function listDataVolumesInNamespace(
  cluster: ClusterId,
  namespace: string,
): Promise<DataVolumeSummary[]> {
  if (!cluster?.trim()) throw new Error("cluster is required");
  if (!namespace?.trim()) throw new Error("namespace is required");
  const { custom } = getClusterClients(cluster);
  try {
    const res = (await custom.listNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
    })) as { items?: KubeDataVolume[] };
    const items = (res.items ?? []).map((dv) => mapSummary(cluster, dv));
    items.sort((a, b) => a.name.localeCompare(b.name));
    return items;
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export type ReusableDataVolumeOption = {
  name: string;
  phase: string;
  size?: string;
  retainedFromVm?: string;
};

/**
 * DataVolumes suitable for attach / create-from-existing:
 * phase Succeeded and not referenced by any VM in the namespace
 * (template volumes or dataVolumeTemplates).
 * Submit still re-checks via assertDataVolumeReusable.
 */
export async function listReusableDataVolumes(
  cluster: ClusterId,
  namespace: string,
): Promise<ReusableDataVolumeOption[]> {
  const [items, attachments] = await Promise.all([
    listDataVolumesInNamespace(cluster, namespace),
    mapDataVolumeAttachmentsInNamespace(cluster, namespace),
  ]);
  const isInUse = (dv: DataVolumeSummary) => {
    if ((attachments.get(dv.name) ?? []).length > 0) return true;
    // claimName often equals DV name; when different, PVC refs also count.
    // We don't have claimName on summary — DV name is enough for kmc standalone
    // disks (claimName === DV name). Roots use the same convention.
    return false;
  };
  const reusable = items
    .filter(
      (dv) =>
        (REUSABLE_DV_PHASES as readonly string[]).includes(dv.phase) &&
        !isInUse(dv),
    )
    .map((dv) => ({
      name: dv.name,
      phase: dv.phase,
      size: dv.size,
      retainedFromVm: dv.retainedFromVm,
    }));
  // Retained disks first, then name.
  reusable.sort((a, b) => {
    const ar = a.retainedFromVm ? 0 : 1;
    const br = b.retainedFromVm ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name);
  });
  return reusable;
}
