import { formatError } from "~/lib/errors";
import type {
  ClusterId,
  CreateNamespaceRequest,
  NamespaceDetail,
  NamespaceSummary,
} from "~/lib/types";
import {
  KMC_MANAGED_BY,
  MANAGED_BY_LABEL,
  VM_ALLOWED_LABEL,
  VM_ALLOWED_LABEL_SELECTOR,
} from "~/lib/k8s/constants";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { toResourceYaml } from "~/lib/k8s/yaml.server";
import { DNS1123_LABEL } from "~/lib/format";
import { listClusters } from "~/vms/vms.server";

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

  const vmCount = await countVms(cluster, name);

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
    return mapSummary(cluster, created);
  } catch (err) {
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
