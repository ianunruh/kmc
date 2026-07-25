import { formatError } from "~/lib/errors";
import type {
  BackendMembership,
  BackendPort,
  BackendSummary,
  ClusterId,
  CreateBackendRequest,
} from "~/lib/types";
import {
  KMC_BACKEND_LABEL_SELECTOR,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_VM,
  KMC_RESOURCE_BACKEND,
} from "~/lib/k8s/constants";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { toResourceYaml } from "~/lib/k8s/yaml.server";
import { listClusters } from "~/vms/vms.server";
import { membershipFromLabels } from "./membership.server";
import { buildServiceManifest } from "./template.server";

interface KubeService {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    type?: string;
    ports?: Array<{
      name?: string;
      port?: number;
      targetPort?: number | string;
      protocol?: string;
    }>;
    selector?: Record<string, string>;
  };
  status?: {
    loadBalancer?: {
      ingress?: Array<{ ip?: string; hostname?: string }>;
    };
  };
}

interface KubeEndpoints {
  subsets?: Array<{
    addresses?: unknown[];
    notReadyAddresses?: unknown[];
    ports?: unknown[];
  }>;
}

function isNotFound(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  return message.includes("404") || message.includes("not found");
}

function mapPorts(
  ports:
    | Array<{
        name?: string;
        port?: number;
        targetPort?: number | string;
        protocol?: string;
      }>
    | undefined,
): BackendPort[] {
  return (ports ?? []).map((p) => {
    let targetPort = p.port ?? 0;
    if (typeof p.targetPort === "number") {
      targetPort = p.targetPort;
    } else if (typeof p.targetPort === "string" && /^\d+$/.test(p.targetPort)) {
      targetPort = Number(p.targetPort);
    }
    return {
      name: p.name,
      port: p.port ?? 0,
      targetPort,
      protocol:
        p.protocol === "UDP" ? "UDP" : p.protocol === "TCP" ? "TCP" : undefined,
    };
  });
}

function mapExternalAddress(svc: KubeService): string | undefined {
  const lb = svc.status?.loadBalancer?.ingress?.[0];
  if (!lb) return undefined;
  return lb.hostname || lb.ip || undefined;
}

function mapSummary(
  cluster: ClusterId,
  svc: KubeService,
  endpoints?: { ready: number; total: number } | null,
): BackendSummary {
  const membership = membershipFromLabels(svc.metadata?.labels);
  return {
    cluster,
    namespace: svc.metadata?.namespace ?? "default",
    name: svc.metadata?.name ?? "unknown",
    serviceType: svc.spec?.type ?? "ClusterIP",
    membership,
    vmName: membership.mode === "single-vm" ? membership.vmName : undefined,
    ports: mapPorts(svc.spec?.ports),
    selector: svc.spec?.selector ?? {},
    age: svc.metadata?.creationTimestamp ?? "",
    externalAddress: mapExternalAddress(svc),
    endpointsReady: endpoints?.ready,
    endpointsTotal: endpoints?.total,
  };
}

export async function readServiceOptional(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<KubeService | null> {
  try {
    const { core } = getClusterClients(cluster);
    return (await core.readNamespacedService({
      name,
      namespace,
    })) as KubeService;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function readEndpointsCounts(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<{ ready: number; total: number } | null> {
  try {
    const { core } = getClusterClients(cluster);
    const ep = (await core.readNamespacedEndpoints({
      name,
      namespace,
    })) as KubeEndpoints;
    let ready = 0;
    let notReady = 0;
    for (const subset of ep.subsets ?? []) {
      ready += subset.addresses?.length ?? 0;
      notReady += subset.notReadyAddresses?.length ?? 0;
    }
    return { ready, total: ready + notReady };
  } catch (err) {
    if (isNotFound(err)) return null;
    // Endpoints may be restricted; callers still work without them
    return null;
  }
}

async function ensureSingleVmExists(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<void> {
  const { custom } = getClusterClients(cluster);
  try {
    await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name: vmName,
    });
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(`VirtualMachine "${namespace}/${vmName}" not found`);
    }
    throw new Error(formatError(err), { cause: err });
  }
}

export async function createBackend(
  input: CreateBackendRequest,
): Promise<BackendSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!input.ports?.length) throw new Error("at least one port is required");

  if (input.membership.mode === "single-vm") {
    if (!input.membership.vmName?.trim()) {
      throw new Error("target VM is required");
    }
    await ensureSingleVmExists(
      input.cluster,
      input.namespace,
      input.membership.vmName,
    );
  }

  const { core } = getClusterClients(input.cluster);

  try {
    await core.readNamespacedService({
      name: input.name,
      namespace: input.namespace,
    });
    throw new Error(
      `Service "${input.namespace}/${input.name}" already exists`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("already exists")) {
      throw err;
    }
    if (!isNotFound(err)) {
      throw new Error(formatError(err), { cause: err });
    }
  }

  const body = buildServiceManifest(input);

  try {
    const created = (await core.createNamespacedService({
      namespace: input.namespace,
      body: body as never,
    })) as KubeService;
    return mapSummary(input.cluster, created);
  } catch (err) {
    throw new Error(`Failed to create Service: ${formatError(err)}`, {
      cause: err,
    });
  }
}

export async function deleteBackend(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  const { core } = getClusterClients(cluster);
  try {
    await core.deleteNamespacedService({ name, namespace });
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(formatError(err), { cause: err });
    }
  }
}

/**
 * Delete a Service only if it is a kmc backend (resource=backend) or missing.
 */
export async function deleteBackendIfManaged(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  const svc = await readServiceOptional(cluster, namespace, name);
  if (!svc) return;
  const labels = svc.metadata?.labels ?? {};
  if (labels[KMC_LABEL_RESOURCE] !== KMC_RESOURCE_BACKEND) {
    throw new Error(
      `Service "${namespace}/${name}" is not a kmc backend; not deleting`,
    );
  }
  await deleteBackend(cluster, namespace, name);
}

export async function getBackend(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<BackendSummary> {
  const svc = await readServiceOptional(cluster, namespace, name);
  if (!svc) {
    throw new Response("Backend Service not found", { status: 404 });
  }
  const endpoints = await readEndpointsCounts(cluster, namespace, name);
  return mapSummary(cluster, svc, endpoints);
}

export async function getBackendYaml(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<string> {
  const { core } = getClusterClients(cluster);
  const svc = await core.readNamespacedService({ name, namespace });
  return toResourceYaml(svc);
}

export async function listBackends(clusterFilter?: ClusterId): Promise<{
  items: BackendSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const contexts = clusterFilter ? [clusterFilter] : getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const items: BackendSummary[] = [];

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const { core } = getClusterClients(id);
        const res = await core.listServiceForAllNamespaces({
          labelSelector: KMC_BACKEND_LABEL_SELECTOR,
        });
        for (const svc of (res.items ?? []) as KubeService[]) {
          items.push(mapSummary(id, svc));
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

/** kmc backend Services bound to a specific VM (single-vm membership). */
export async function listBackendsForVm(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<BackendSummary[]> {
  const { core } = getClusterClients(cluster);
  const res = await core.listNamespacedService({
    namespace,
    labelSelector: `${KMC_BACKEND_LABEL_SELECTOR},${KMC_LABEL_VM}=${vmName}`,
  });
  const items = ((res.items ?? []) as KubeService[]).map((svc) =>
    mapSummary(cluster, svc),
  );
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

export function singleVmMembership(vmName: string): BackendMembership {
  return { mode: "single-vm", vmName };
}
