import { formatError } from "~/lib/errors";
import type {
  ClusterId,
  CreateImageRequest,
  ImageDetail,
  ImageSummary,
} from "~/lib/types";
import {
  IMAGE_PREFERENCE_LABEL,
  KMC_LABEL_RESOURCE,
  KMC_MANAGED_BY,
  KMC_RESOURCE_IMAGE,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { getImageNamespace, listReadyImages } from "~/lib/k8s/image-catalog.server";
import { toResourceYaml } from "~/lib/k8s/yaml.server";
import { listClusters } from "~/vms/vms.server";

export { getImageNamespace, listReadyImages };

interface KubeDataVolume {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    source?: {
      blank?: unknown;
      pvc?: { name?: string; namespace?: string };
      http?: { url?: string };
      registry?: { url?: string };
      s3?: { url?: string };
      gcs?: { url?: string };
      upload?: unknown;
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

interface KubePvc {
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
    accessModes?: string[];
    volumeMode?: string;
    storageClassName?: string;
    resources?: { requests?: { storage?: string } };
  };
  status?: {
    phase?: string;
    capacity?: { storage?: string };
  };
}

function sourceInfo(dv: KubeDataVolume): { kind: string; detail?: string } {
  const src = dv.spec?.source;
  if (!src) {
    // virtctl image-upload often leaves no explicit source once complete
    const msg =
      dv.metadata?.annotations?.["cdi.kubevirt.io/storage.condition.running.message"];
    if (msg?.toLowerCase().includes("upload")) return { kind: "upload" };
    return { kind: "unknown" };
  }
  if (src.blank != null) return { kind: "blank" };
  if (src.upload != null) return { kind: "upload" };
  if (src.pvc) {
    return {
      kind: "pvc",
      detail: `${src.pvc.namespace ?? "?"}/${src.pvc.name ?? "?"}`,
    };
  }
  if (src.http?.url) return { kind: "http", detail: src.http.url };
  if (src.registry?.url) return { kind: "registry", detail: src.registry.url };
  if (src.s3?.url) return { kind: "s3", detail: src.s3.url };
  if (src.gcs?.url) return { kind: "gcs", detail: src.gcs.url };
  if (src.snapshot != null) return { kind: "snapshot" };
  return { kind: "other" };
}

function preferenceFromLabels(
  labels: Record<string, string> | undefined,
): string | undefined {
  const p = labels?.[IMAGE_PREFERENCE_LABEL]?.trim();
  return p || undefined;
}

function mapMerged(
  cluster: ClusterId,
  namespace: string,
  name: string,
  dv: KubeDataVolume | undefined,
  pvc: KubePvc | undefined,
): ImageSummary {
  const src = dv ? sourceInfo(dv) : undefined;
  const size =
    dv?.spec?.storage?.resources?.requests?.storage ??
    dv?.spec?.pvc?.resources?.requests?.storage ??
    pvc?.spec?.resources?.requests?.storage;
  const storageClass =
    dv?.spec?.storage?.storageClassName ??
    dv?.spec?.pvc?.storageClassName ??
    pvc?.spec?.storageClassName ??
    undefined;
  const volumeMode =
    dv?.spec?.storage?.volumeMode ??
    dv?.spec?.pvc?.volumeMode ??
    pvc?.spec?.volumeMode ??
    undefined;
  const capacity = pvc?.status?.capacity?.storage;
  const phase =
    dv?.status?.phase ??
    pvc?.status?.phase ??
    (dv ? "Unknown" : pvc ? "Unknown" : "Unknown");
  const running = dv?.status?.conditions?.find((c) => c.type === "Running");
  const pvcBound = pvc?.status?.phase === "Bound";
  const age = dv?.metadata?.creationTimestamp ?? pvc?.metadata?.creationTimestamp ?? "";

  // Preference: PVC wins (Launch VM reads the claim); fall back to DV labels.
  const preference =
    preferenceFromLabels(pvc?.metadata?.labels) ??
    preferenceFromLabels(dv?.metadata?.labels);

  // Upload-created PVCs without a DV source still count as ready when Bound.
  const ready = pvcBound;

  return {
    cluster,
    namespace,
    name,
    phase,
    progress: dv?.status?.progress,
    size,
    capacity,
    storageClass,
    volumeMode,
    preference,
    sourceKind: src?.kind,
    sourceDetail: src?.detail,
    age,
    message: running?.message ?? running?.reason,
    ready,
    hasDataVolume: Boolean(dv),
    hasPvc: Boolean(pvc),
  };
}

function mapDetail(
  cluster: ClusterId,
  namespace: string,
  name: string,
  dv: KubeDataVolume | undefined,
  pvc: KubePvc | undefined,
): ImageDetail {
  const summary = mapMerged(cluster, namespace, name, dv, pvc);
  const labels = {
    ...(dv?.metadata?.labels ?? {}),
    ...(pvc?.metadata?.labels ?? {}),
  };
  const annotations = Object.fromEntries(
    Object.entries({
      ...(dv?.metadata?.annotations ?? {}),
      ...(pvc?.metadata?.annotations ?? {}),
    }).filter(
      ([k]) =>
        !k.startsWith("cdi.kubevirt.io/storage.clone.token") &&
        !k.startsWith("cdi.kubevirt.io/storage.extended.clone.token") &&
        !k.startsWith("kubectl.kubernetes.io/"),
    ),
  );
  const conditions = (dv?.status?.conditions ?? []).map((c) => ({
    type: c.type ?? "Unknown",
    status: c.status ?? "Unknown",
    reason: c.reason,
    message: c.message,
    lastTransitionTime: c.lastTransitionTime ?? c.lastHeartbeatTime,
  }));

  return {
    ...summary,
    uid: dv?.metadata?.uid ?? pvc?.metadata?.uid,
    accessModes:
      dv?.spec?.storage?.accessModes ??
      dv?.spec?.pvc?.accessModes ??
      pvc?.spec?.accessModes,
    claimName: dv?.status?.claimName ?? (pvc ? name : undefined),
    labels,
    annotations,
    conditions,
  };
}

async function listDataVolumesInImageNs(
  cluster: ClusterId,
  namespace: string,
): Promise<KubeDataVolume[]> {
  const { custom } = getClusterClients(cluster);
  try {
    const res = (await custom.listNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
    })) as { items?: KubeDataVolume[] };
    return res.items ?? [];
  } catch {
    return [];
  }
}

async function listPvcsInImageNs(
  cluster: ClusterId,
  namespace: string,
): Promise<KubePvc[]> {
  const { core } = getClusterClients(cluster);
  try {
    const res = await core.listNamespacedPersistentVolumeClaim({ namespace });
    return (res.items ?? []) as KubePvc[];
  } catch {
    return [];
  }
}

export async function listImages(clusterFilter?: ClusterId): Promise<{
  items: ImageSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const contexts = clusterFilter ? [clusterFilter] : getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const namespace = getImageNamespace();
  const items: ImageSummary[] = [];

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const [dvs, pvcs] = await Promise.all([
          listDataVolumesInImageNs(id, namespace),
          listPvcsInImageNs(id, namespace),
        ]);
        const dvByName = new Map<string, KubeDataVolume>();
        for (const dv of dvs) {
          const n = dv.metadata?.name;
          if (n) dvByName.set(n, dv);
        }
        const pvcByName = new Map<string, KubePvc>();
        for (const pvc of pvcs) {
          const n = pvc.metadata?.name;
          if (n) pvcByName.set(n, pvc);
        }
        const names = new Set([...dvByName.keys(), ...pvcByName.keys()]);
        for (const name of names) {
          items.push(
            mapMerged(id, namespace, name, dvByName.get(name), pvcByName.get(name)),
          );
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
    return a.name.localeCompare(b.name);
  });

  return { items, clusters };
}

export async function getImage(cluster: ClusterId, name: string): Promise<ImageDetail> {
  if (!cluster?.trim()) throw new Error("cluster is required");
  if (!name?.trim()) throw new Error("name is required");
  const namespace = getImageNamespace();
  const { custom, core } = getClusterClients(cluster);

  let dv: KubeDataVolume | undefined;
  let pvc: KubePvc | undefined;

  try {
    dv = (await custom.getNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      name,
    })) as KubeDataVolume;
  } catch (err) {
    const message = formatError(err);
    if (!message.includes("404") && !message.toLowerCase().includes("not found")) {
      throw new Error(message, { cause: err });
    }
  }

  try {
    pvc = (await core.readNamespacedPersistentVolumeClaim({
      name,
      namespace,
    })) as KubePvc;
  } catch (err) {
    const message = formatError(err);
    if (!message.includes("404") && !message.toLowerCase().includes("not found")) {
      throw new Error(message, { cause: err });
    }
  }

  if (!dv && !pvc) {
    throw new Response("Image not found", { status: 404 });
  }

  return mapDetail(cluster, namespace, name, dv, pvc);
}

export async function createImage(input: CreateImageRequest): Promise<ImageSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!input.url?.trim()) throw new Error("image URL is required");
  if (!input.size?.trim()) throw new Error("size is required");

  const namespace = getImageNamespace();
  const preference = input.preference?.trim() || undefined;
  const labels: Record<string, string> = {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_IMAGE,
  };
  if (preference) {
    labels[IMAGE_PREFERENCE_LABEL] = preference;
  }

  const body = {
    apiVersion: "cdi.kubevirt.io/v1beta1",
    kind: "DataVolume",
    metadata: {
      name: input.name,
      namespace,
      labels,
    },
    spec: {
      source: {
        http: { url: input.url.trim() },
      },
      storage: {
        accessModes: ["ReadWriteOnce"],
        volumeMode: input.volumeMode ?? "Block",
        resources: {
          requests: {
            storage: input.size.trim(),
          },
        },
        ...(input.storageClass?.trim()
          ? { storageClassName: input.storageClass.trim() }
          : {}),
      },
    },
  };

  const { custom, core } = getClusterClients(input.cluster);
  try {
    const created = (await custom.createNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      body,
    })) as KubeDataVolume;

    // Prefer labeling the PVC as soon as it exists (Launch VM reads the claim).
    if (preference) {
      try {
        const pvc = await core.readNamespacedPersistentVolumeClaim({
          name: input.name,
          namespace,
        });
        const nextLabels = {
          ...(pvc.metadata?.labels ?? {}),
          [IMAGE_PREFERENCE_LABEL]: preference,
        };
        await core.replaceNamespacedPersistentVolumeClaim({
          name: input.name,
          namespace,
          body: {
            ...pvc,
            metadata: {
              ...pvc.metadata,
              labels: nextLabels,
            },
          },
        });
      } catch {
        // PVC may not exist yet during import — DV label is the fallback.
      }
    }

    return mapMerged(input.cluster, namespace, input.name, created, undefined);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

/**
 * Set or clear the cluster-preference label on the PVC (and DV when present).
 * Launch VM reads the PVC label via getImagePreference.
 */
export async function updateImagePreference(
  cluster: ClusterId,
  name: string,
  preference: string | null,
): Promise<void> {
  if (!cluster?.trim()) throw new Error("cluster is required");
  if (!name?.trim()) throw new Error("name is required");
  const namespace = getImageNamespace();
  const { custom, core } = getClusterClients(cluster);
  const pref = preference?.trim() || null;

  let touched = false;

  try {
    const pvc = await core.readNamespacedPersistentVolumeClaim({
      name,
      namespace,
    });
    const labels = { ...(pvc.metadata?.labels ?? {}) };
    if (pref) labels[IMAGE_PREFERENCE_LABEL] = pref;
    else delete labels[IMAGE_PREFERENCE_LABEL];
    await core.replaceNamespacedPersistentVolumeClaim({
      name,
      namespace,
      body: {
        ...pvc,
        metadata: {
          ...pvc.metadata,
          labels,
        },
      },
    });
    touched = true;
  } catch (err) {
    const message = formatError(err);
    if (!message.includes("404") && !message.toLowerCase().includes("not found")) {
      throw new Error(message, { cause: err });
    }
  }

  try {
    const dv = (await custom.getNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      name,
    })) as KubeDataVolume;
    const labels = { ...(dv.metadata?.labels ?? {}) };
    if (pref) labels[IMAGE_PREFERENCE_LABEL] = pref;
    else delete labels[IMAGE_PREFERENCE_LABEL];
    await custom.replaceNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      name,
      body: {
        ...dv,
        metadata: {
          ...dv.metadata,
          labels,
        },
      },
    });
    touched = true;
  } catch (err) {
    const message = formatError(err);
    if (!message.includes("404") && !message.toLowerCase().includes("not found")) {
      throw new Error(message, { cause: err });
    }
  }

  if (!touched) {
    throw new Error(`Image "${name}" was not found in ${namespace}`);
  }
}

/**
 * Delete the golden image: prefer DataVolume (cascades to owned PVC).
 * Orphan PVCs (no DV) are deleted directly.
 */
export async function deleteImage(cluster: ClusterId, name: string): Promise<void> {
  if (!cluster?.trim()) throw new Error("cluster is required");
  if (!name?.trim()) throw new Error("name is required");
  const namespace = getImageNamespace();
  const { custom, core } = getClusterClients(cluster);

  let deletedDv = false;
  try {
    await custom.deleteNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      name,
    });
    deletedDv = true;
  } catch (err) {
    const message = formatError(err);
    if (!message.includes("404") && !message.toLowerCase().includes("not found")) {
      throw new Error(message, { cause: err });
    }
  }

  // If there was no DV, or PVC is orphaned after DV delete failed to cascade,
  // remove the PVC. Ignore 404 when DV cascade already removed it.
  try {
    await core.deleteNamespacedPersistentVolumeClaim({ name, namespace });
  } catch (err) {
    const message = formatError(err);
    if (message.includes("404") || message.toLowerCase().includes("not found")) {
      if (!deletedDv) {
        throw new Error(`Image "${name}" was not found in ${namespace}`);
      }
      return;
    }
    // PVC may still be terminating after DV delete — surface other errors.
    if (!deletedDv) {
      throw new Error(message, { cause: err });
    }
  }
}

/** YAML for detail page: DV preferred, else PVC. */
export async function getImageYaml(cluster: ClusterId, name: string): Promise<string> {
  const namespace = getImageNamespace();
  const { custom, core } = getClusterClients(cluster);

  try {
    const dv = await custom.getNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      name,
    });
    return toResourceYaml(dv);
  } catch {
    // fall through to PVC
  }

  try {
    const pvc = await core.readNamespacedPersistentVolumeClaim({
      name,
      namespace,
    });
    return toResourceYaml(pvc);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}
