import { formatError } from "~/lib/errors";
import type {
  ClusterId,
  CreateNamespaceRequest,
  NamespaceDetail,
  NamespaceQuota,
  NamespaceQuotaLimits,
  NamespaceSummary,
  UpsertNamespaceQuotaRequest,
} from "~/lib/types";
import {
  KMC_LABEL_RESOURCE,
  KMC_MANAGED_BY,
  KMC_NAMESPACE_QUOTA_NAME,
  KMC_RESOURCE_NAMESPACE_QUOTA,
  MANAGED_BY_LABEL,
  VM_ALLOWED_LABEL,
  VM_ALLOWED_LABEL_SELECTOR,
} from "~/lib/k8s/constants";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { toResourceYaml } from "~/lib/k8s/yaml.server";
import { DNS1123_LABEL } from "~/lib/format";
import { listClusters } from "~/vms/vms.server";
import {
  hardFromLimits,
  hasAnyLimit,
  type KubeResourceQuota,
  mapResourceQuota,
} from "./quota";
import {
  isValidByteQuantity,
  isValidCpuQuantity,
} from "./quantity";

type KubeNamespace = {
  metadata?: {
    name?: string;
    uid?: string;
    /** client-node often returns a Date for core/v1 resources */
    creationTimestamp?: string | Date;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  status?: {
    phase?: string;
  };
};

function isNotFound(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  return message.includes("404") || message.includes("not found");
}

function isAlreadyExists(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  return message.includes("409") || message.includes("already exists");
}

/** Normalize client-node Date | string timestamps to ISO strings for UI. */
function toIsoTimestamp(value: string | Date | undefined): string {
  if (value == null) return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (typeof value === "string") return value;
  return "";
}

function mapSummary(cluster: ClusterId, ns: KubeNamespace): NamespaceSummary {
  const labels = ns.metadata?.labels ?? {};
  return {
    cluster,
    name: ns.metadata?.name ?? "unknown",
    phase: ns.status?.phase ?? "Unknown",
    age: toIsoTimestamp(ns.metadata?.creationTimestamp),
    managedByKmc: labels[MANAGED_BY_LABEL] === KMC_MANAGED_BY,
  };
}

function validateName(name: string): void {
  if (!name) throw new Error("name is required");
  if (name.length > 63) throw new Error("name max length is 63");
  if (!DNS1123_LABEL.test(name)) {
    throw new Error(
      "name must be a DNS-1123 label (lowercase alphanumeric and hyphens)",
    );
  }
}

export async function listNamespaces(clusterFilter?: ClusterId): Promise<{
  items: NamespaceSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const allContexts = getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const fetchIds = clusterFilter ? [clusterFilter] : allContexts;
  const items: NamespaceSummary[] = [];

  await Promise.all(
    fetchIds.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const { core } = getClusterClients(id);
        const res = await core.listNamespace({
          labelSelector: VM_ALLOWED_LABEL_SELECTOR,
        });
        for (const ns of res.items ?? []) {
          items.push(mapSummary(id, ns as KubeNamespace));
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

async function countVms(cluster: ClusterId, namespace: string): Promise<number> {
  const { custom } = getClusterClients(cluster);
  try {
    const res = (await custom.listNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
    })) as { items?: unknown[] };
    return res.items?.length ?? 0;
  } catch {
    return 0;
  }
}

function isManagedQuota(rq: KubeResourceQuota): boolean {
  const labels = rq.metadata?.labels ?? {};
  return (
    labels[MANAGED_BY_LABEL] === KMC_MANAGED_BY &&
    labels[KMC_LABEL_RESOURCE] === KMC_RESOURCE_NAMESPACE_QUOTA
  );
}

/** Lightweight guard: namespace exists and is vm-allowed (no quota/VM fan-out). */
async function ensureVmAllowedNamespace(
  cluster: ClusterId,
  name: string,
): Promise<void> {
  const { core } = getClusterClients(cluster);
  let ns: KubeNamespace;
  try {
    ns = (await core.readNamespace({ name })) as KubeNamespace;
  } catch (err) {
    if (isNotFound(err)) {
      throw new Response("Namespace not found", { status: 404 });
    }
    throw new Error(formatError(err), { cause: err });
  }
  const labels = ns.metadata?.labels ?? {};
  if (labels[VM_ALLOWED_LABEL] !== "true") {
    throw new Response(
      `Namespace is not labeled ${VM_ALLOWED_LABEL}=true`,
      { status: 404 },
    );
  }
}

/** List all ResourceQuotas in a namespace; managed quota first when present. */
export async function listNamespaceQuotas(
  cluster: ClusterId,
  namespace: string,
): Promise<NamespaceQuota[]> {
  const { core } = getClusterClients(cluster);
  try {
    const res = await core.listNamespacedResourceQuota({ namespace });
    const items = (res.items ?? []) as KubeResourceQuota[];
    const mapped = items.map((rq) => mapResourceQuota(rq, isManagedQuota(rq)));
    mapped.sort((a, b) => {
      if (a.managedByKmc !== b.managedByKmc) return a.managedByKmc ? -1 : 1;
      if (a.name === KMC_NAMESPACE_QUOTA_NAME) return -1;
      if (b.name === KMC_NAMESPACE_QUOTA_NAME) return 1;
      return a.name.localeCompare(b.name);
    });
    return mapped;
  } catch (err) {
    // Listing is best-effort for capacity UI — don't fail the whole namespace.
    if (isNotFound(err)) return [];
    console.error(
      `[namespace.quotas] list failed ${cluster}/${namespace}:`,
      formatError(err),
    );
    return [];
  }
}

function validateQuotaLimits(limits: NamespaceQuotaLimits): void {
  if (limits.cpu != null && limits.cpu.trim()) {
    if (!isValidCpuQuantity(limits.cpu)) {
      throw new Error(
        `Invalid CPU quota "${limits.cpu}" (use cores like 16 or millicores like 500m)`,
      );
    }
  }
  if (limits.memory != null && limits.memory.trim()) {
    if (!isValidByteQuantity(limits.memory)) {
      throw new Error(
        `Invalid memory quota "${limits.memory}" (use a quantity like 64Gi)`,
      );
    }
  }
  if (limits.storage != null && limits.storage.trim()) {
    if (!isValidByteQuantity(limits.storage)) {
      throw new Error(
        `Invalid storage quota "${limits.storage}" (use a quantity like 500Gi)`,
      );
    }
  }
  if (limits.vms != null) {
    if (!Number.isFinite(limits.vms) || limits.vms < 0 || !Number.isInteger(limits.vms)) {
      throw new Error("VM count quota must be a non-negative integer");
    }
  }
  if (limits.pvcs != null) {
    if (
      !Number.isFinite(limits.pvcs) ||
      limits.pvcs < 0 ||
      !Number.isInteger(limits.pvcs)
    ) {
      throw new Error("PVC count quota must be a non-negative integer");
    }
  }
  if (!hasAnyLimit(limits)) {
    throw new Error("At least one quota limit is required");
  }
}

function managedQuotaLabels(): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_NAMESPACE_QUOTA,
  };
}

/**
 * Create or replace the kmc-managed ResourceQuota for a namespace.
 * Only updates hard limits on the fixed `kmc-quota` object.
 */
export async function upsertNamespaceQuota(
  input: UpsertNamespaceQuotaRequest,
): Promise<NamespaceQuota> {
  const cluster = input.cluster?.trim();
  const name = input.name?.trim() ?? "";
  if (!cluster || !name) throw new Error("cluster and name are required");
  validateQuotaLimits(input.quota);

  await ensureVmAllowedNamespace(cluster, name);

  const hard = hardFromLimits(input.quota);
  const { core } = getClusterClients(cluster);
  const quotaName = KMC_NAMESPACE_QUOTA_NAME;

  try {
    const existing = (await core.readNamespacedResourceQuota({
      name: quotaName,
      namespace: name,
    })) as KubeResourceQuota;

    if (!isManagedQuota(existing)) {
      throw new Error(
        `ResourceQuota "${quotaName}" exists but is not managed by kmc — ` +
          `rename or delete it before setting quotas in the console`,
      );
    }

    const updated = (await core.replaceNamespacedResourceQuota({
      name: quotaName,
      namespace: name,
      body: {
        apiVersion: "v1",
        kind: "ResourceQuota",
        metadata: {
          name: quotaName,
          namespace: name,
          resourceVersion: existing.metadata?.resourceVersion,
          labels: {
            ...(existing.metadata?.labels ?? {}),
            ...managedQuotaLabels(),
          },
        },
        spec: { hard },
      },
    })) as KubeResourceQuota;
    return mapResourceQuota(updated, true);
  } catch (err) {
    if (err instanceof Error && err.message.includes("not managed by kmc")) {
      throw err;
    }
    if (!isNotFound(err)) {
      throw new Error(
        `Failed to update ResourceQuota ${cluster}/${name}/${quotaName}: ${formatError(err)}`,
        { cause: err },
      );
    }
  }

  try {
    const created = (await core.createNamespacedResourceQuota({
      namespace: name,
      body: {
        apiVersion: "v1",
        kind: "ResourceQuota",
        metadata: {
          name: quotaName,
          namespace: name,
          labels: managedQuotaLabels(),
        },
        spec: { hard },
      },
    })) as KubeResourceQuota;
    return mapResourceQuota(created, true);
  } catch (err) {
    throw new Error(
      `Failed to create ResourceQuota ${cluster}/${name}/${quotaName}: ${formatError(err)}`,
      { cause: err },
    );
  }
}

/** Delete the kmc-managed ResourceQuota (no-op if absent). */
export async function deleteNamespaceQuota(
  cluster: ClusterId,
  name: string,
): Promise<void> {
  if (!cluster?.trim() || !name?.trim()) {
    throw new Error("cluster and name are required");
  }
  await ensureVmAllowedNamespace(cluster, name);

  const { core } = getClusterClients(cluster);
  const quotaName = KMC_NAMESPACE_QUOTA_NAME;

  try {
    const existing = (await core.readNamespacedResourceQuota({
      name: quotaName,
      namespace: name,
    })) as KubeResourceQuota;
    if (!isManagedQuota(existing)) {
      throw new Error(
        `ResourceQuota "${quotaName}" exists but is not managed by kmc — delete it with kubectl`,
      );
    }
    await core.deleteNamespacedResourceQuota({ name: quotaName, namespace: name });
  } catch (err) {
    if (isNotFound(err)) return;
    if (err instanceof Error && err.message.includes("not managed by kmc")) {
      throw err;
    }
    throw new Error(
      `Failed to delete ResourceQuota ${cluster}/${name}/${quotaName}: ${formatError(err)}`,
      { cause: err },
    );
  }
}

export async function getNamespace(
  cluster: ClusterId,
  name: string,
): Promise<NamespaceDetail> {
  const { core } = getClusterClients(cluster);
  let ns: KubeNamespace;
  try {
    ns = (await core.readNamespace({ name })) as KubeNamespace;
  } catch (err) {
    if (isNotFound(err)) {
      throw new Response("Namespace not found", { status: 404 });
    }
    throw new Error(formatError(err), { cause: err });
  }

  const labels = ns.metadata?.labels ?? {};
  if (labels[VM_ALLOWED_LABEL] !== "true") {
    throw new Response(
      `Namespace is not labeled ${VM_ALLOWED_LABEL}=true`,
      { status: 404 },
    );
  }

  const [vmCount, quotas] = await Promise.all([
    countVms(cluster, name),
    listNamespaceQuotas(cluster, name),
  ]);
  const quota =
    quotas.find((q) => q.managedByKmc) ??
    quotas.find((q) => q.name === KMC_NAMESPACE_QUOTA_NAME) ??
    null;

  return {
    ...mapSummary(cluster, ns),
    uid: ns.metadata?.uid,
    labels,
    annotations: Object.fromEntries(
      Object.entries(ns.metadata?.annotations ?? {}).filter(
        ([k]) => !k.startsWith("kubectl.kubernetes.io/"),
      ),
    ),
    vmCount,
    quota,
    quotas,
  };
}

export async function getNamespaceYaml(
  cluster: ClusterId,
  name: string,
): Promise<string> {
  const { core } = getClusterClients(cluster);
  try {
    const ns = await core.readNamespace({ name });
    return toResourceYaml(ns);
  } catch (err) {
    if (isNotFound(err)) {
      throw new Response("Namespace not found", { status: 404 });
    }
    throw new Error(formatError(err), { cause: err });
  }
}

export async function createNamespace(
  input: CreateNamespaceRequest,
): Promise<NamespaceSummary> {
  const cluster = input.cluster?.trim();
  const name = input.name?.trim() ?? "";
  if (!cluster) throw new Error("cluster is required");
  validateName(name);

  if (input.quota && hasAnyLimit(input.quota)) {
    validateQuotaLimits(input.quota);
  }

  const { core } = getClusterClients(cluster);

  try {
    const existing = await core.readNamespace({ name });
    const labels = existing.metadata?.labels ?? {};
    if (labels[VM_ALLOWED_LABEL] === "true") {
      throw new Error(`Namespace "${name}" already exists and is vm-allowed`);
    }
    throw new Error(
      `Namespace "${name}" already exists without ${VM_ALLOWED_LABEL}=true ` +
        `(label it manually or pick another name)`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Namespace ")) {
      throw err;
    }
    if (!isNotFound(err)) {
      throw new Error(formatError(err), { cause: err });
    }
  }

  try {
    const created = (await core.createNamespace({
      body: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name,
          labels: {
            [VM_ALLOWED_LABEL]: "true",
            [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
          },
        },
      },
    })) as KubeNamespace;

    if (input.quota && hasAnyLimit(input.quota)) {
      try {
        await upsertNamespaceQuota({ cluster, name, quota: input.quota });
      } catch (quotaErr) {
        // Namespace already exists — surface the quota error so the user can fix it.
        throw new Error(
          `Namespace created but ResourceQuota failed: ${formatError(quotaErr)}`,
          { cause: quotaErr },
        );
      }
    }

    return mapSummary(cluster, created);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Namespace created but")) {
      throw err;
    }
    if (isAlreadyExists(err)) {
      throw new Error(`Namespace "${name}" already exists`);
    }
    throw new Error(
      `Failed to create namespace ${cluster}/${name}: ${formatError(err)}`,
      { cause: err },
    );
  }
}

/**
 * Deletes the Namespace. Kubernetes cascades namespaced resources.
 * Blocked when VMs still exist so users do not wipe workloads by accident.
 */
export async function deleteNamespace(
  cluster: ClusterId,
  name: string,
): Promise<void> {
  if (!cluster?.trim() || !name?.trim()) {
    throw new Error("cluster and name are required");
  }

  const detail = await getNamespace(cluster, name);
  if (detail.vmCount > 0) {
    throw new Error(
      `Cannot delete namespace "${name}": ${detail.vmCount} VirtualMachine(s) still exist`,
    );
  }

  const { core } = getClusterClients(cluster);
  try {
    await core.deleteNamespace({ name });
  } catch (err) {
    if (isNotFound(err)) {
      throw new Response("Namespace not found", { status: 404 });
    }
    throw new Error(
      `Failed to delete namespace ${cluster}/${name}: ${formatError(err)}`,
      { cause: err },
    );
  }
}
