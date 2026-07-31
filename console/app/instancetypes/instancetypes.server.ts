import { formatError } from "~/lib/errors";
import type {
  ClusterId,
  ClusterInstanceTypeDetail,
  ClusterInstanceTypeSummary,
  UpsertClusterInstanceTypeRequest,
} from "~/lib/types";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { KMC_MANAGED_BY, MANAGED_BY_LABEL } from "~/lib/k8s/constants";
import { listClusters } from "~/vms/vms.server";
import {
  deriveInstanceTypeSize,
  isBuiltinClusterInstanceType,
  sortInstanceTypes,
} from "./options";

const GROUP = "instancetype.kubevirt.io";
const VERSION = "v1beta1";
const PLURAL = "virtualmachineclusterinstancetypes";

interface KubeClusterInstanceType {
  metadata?: {
    name?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    resourceVersion?: string;
  };
  spec?: {
    cpu?: { guest?: number };
    memory?: { guest?: string };
  };
}

function mapSummary(
  cluster: ClusterId,
  it: KubeClusterInstanceType,
): ClusterInstanceTypeSummary {
  const labels = it.metadata?.labels ?? {};
  const name = it.metadata?.name ?? "unknown";
  const className = labels["instancetype.kubevirt.io/class"] || undefined;
  const size = deriveInstanceTypeSize(
    name,
    labels["instancetype.kubevirt.io/size"],
  );
  const vendor = labels["instancetype.kubevirt.io/vendor"] || undefined;
  const commonVersion =
    labels["instancetype.kubevirt.io/common-instancetypes-version"] || undefined;
  const cpuFromSpec = it.spec?.cpu?.guest;
  const cpuFromLabel = labels["instancetype.kubevirt.io/cpu"];
  const cpu =
    cpuFromSpec ??
    (cpuFromLabel != null && cpuFromLabel !== "" ? Number(cpuFromLabel) : 0);

  return {
    cluster,
    name,
    cpu: Number.isFinite(cpu) ? cpu : 0,
    memory:
      it.spec?.memory?.guest ?? labels["instancetype.kubevirt.io/memory"] ?? "",
    age: it.metadata?.creationTimestamp ?? "",
    class: className,
    size,
    vendor,
    commonVersion,
    builtin: isBuiltinClusterInstanceType(labels),
  };
}

function mapDetail(
  cluster: ClusterId,
  it: KubeClusterInstanceType,
): ClusterInstanceTypeDetail {
  return {
    ...mapSummary(cluster, it),
    uid: it.metadata?.uid,
    labels: it.metadata?.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(it.metadata?.annotations ?? {}).filter(
        ([k]) => !k.startsWith("kubectl.kubernetes.io/"),
      ),
    ),
  };
}

function buildBody(input: UpsertClusterInstanceTypeRequest) {
  return {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: "VirtualMachineClusterInstancetype",
    metadata: {
      name: input.name,
      labels: {
        [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
        "instancetype.kubevirt.io/cpu": String(input.cpu),
        "instancetype.kubevirt.io/memory": input.memory,
      },
    },
    spec: {
      cpu: { guest: input.cpu },
      memory: { guest: input.memory },
    },
  };
}

function assertMutable(it: KubeClusterInstanceType, action: "update" | "delete") {
  if (isBuiltinClusterInstanceType(it.metadata?.labels)) {
    const name = it.metadata?.name ?? "unknown";
    throw new Error(
      `Instance type "${name}" is built-in (provided by the KubeVirt operator / common-instancetypes) and cannot be ${action === "update" ? "edited" : "deleted"}`,
    );
  }
}

export async function listClusterInstanceTypes(clusterFilter?: ClusterId): Promise<{
  items: ClusterInstanceTypeSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const contexts = clusterFilter ? [clusterFilter] : getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const items: ClusterInstanceTypeSummary[] = [];

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const { custom } = getClusterClients(id);
        const res = (await custom.listClusterCustomObject({
          group: GROUP,
          version: VERSION,
          plural: PLURAL,
        })) as { items?: KubeClusterInstanceType[] };
        for (const it of res.items ?? []) {
          items.push(mapSummary(id, it));
        }
      } catch (err) {
        // Missing CRD (e.g. homelab) — treat as empty, not fatal for that cluster
        const msg = formatError(err).toLowerCase();
        if (
          msg.includes("not found") ||
          msg.includes("404") ||
          msg.includes("could not find")
        ) {
          return;
        }
        if (cluster) {
          cluster.reachable = false;
          cluster.error = formatError(err);
        }
      }
    }),
  );

  // Cluster first, then common-instancetypes class/size order within a cluster.
  const byCluster = new Map<string, ClusterInstanceTypeSummary[]>();
  for (const it of items) {
    const list = byCluster.get(it.cluster) ?? [];
    list.push(it);
    byCluster.set(it.cluster, list);
  }
  const sorted: ClusterInstanceTypeSummary[] = [];
  for (const clusterId of [...byCluster.keys()].sort()) {
    sorted.push(...sortInstanceTypes(byCluster.get(clusterId)!));
  }

  return { items: sorted, clusters };
}

export async function getClusterInstanceType(
  cluster: ClusterId,
  name: string,
): Promise<ClusterInstanceTypeDetail> {
  const { custom } = getClusterClients(cluster);
  try {
    const it = (await custom.getClusterCustomObject({
      group: GROUP,
      version: VERSION,
      plural: PLURAL,
      name,
    })) as KubeClusterInstanceType;
    return mapDetail(cluster, it);
  } catch (err) {
    const message = formatError(err);
    if (message.includes("404") || message.toLowerCase().includes("not found")) {
      throw new Response("Instance type not found", { status: 404 });
    }
    throw new Error(message, { cause: err });
  }
}

export async function createClusterInstanceType(
  input: UpsertClusterInstanceTypeRequest,
): Promise<ClusterInstanceTypeSummary> {
  validateUpsert(input);
  const { custom } = getClusterClients(input.cluster);
  try {
    const created = (await custom.createClusterCustomObject({
      group: GROUP,
      version: VERSION,
      plural: PLURAL,
      body: buildBody(input),
    })) as KubeClusterInstanceType;
    return mapSummary(input.cluster, created);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export async function updateClusterInstanceType(
  input: UpsertClusterInstanceTypeRequest,
): Promise<ClusterInstanceTypeSummary> {
  validateUpsert(input);
  const { custom } = getClusterClients(input.cluster);
  try {
    const existing = (await custom.getClusterCustomObject({
      group: GROUP,
      version: VERSION,
      plural: PLURAL,
      name: input.name,
    })) as KubeClusterInstanceType;
    assertMutable(existing, "update");

    const body = {
      ...existing,
      metadata: {
        ...existing.metadata,
        labels: {
          ...(existing.metadata?.labels ?? {}),
          [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
          "instancetype.kubevirt.io/cpu": String(input.cpu),
          "instancetype.kubevirt.io/memory": input.memory,
        },
      },
      spec: {
        ...(existing.spec ?? {}),
        cpu: { guest: input.cpu },
        memory: { guest: input.memory },
      },
    };

    const updated = (await custom.replaceClusterCustomObject({
      group: GROUP,
      version: VERSION,
      plural: PLURAL,
      name: input.name,
      body,
    })) as KubeClusterInstanceType;
    return mapSummary(input.cluster, updated);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export async function deleteClusterInstanceType(
  cluster: ClusterId,
  name: string,
): Promise<void> {
  const { custom } = getClusterClients(cluster);
  try {
    const existing = (await custom.getClusterCustomObject({
      group: GROUP,
      version: VERSION,
      plural: PLURAL,
      name,
    })) as KubeClusterInstanceType;
    assertMutable(existing, "delete");

    await custom.deleteClusterCustomObject({
      group: GROUP,
      version: VERSION,
      plural: PLURAL,
      name,
    });
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

function validateUpsert(input: UpsertClusterInstanceTypeRequest) {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!Number.isFinite(input.cpu) || input.cpu < 1) {
    throw new Error("cpu must be a positive integer");
  }
  if (!input.memory?.trim()) throw new Error("memory is required");
}
