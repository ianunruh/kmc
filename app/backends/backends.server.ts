import { formatError } from "~/lib/errors";
import type {
  BackendMatchedVm,
  BackendMembership,
  BackendPort,
  BackendSummary,
  ClusterId,
  CreateBackendRequest,
  UpdateBackendRequest,
} from "~/lib/types";
import {
  KMC_ANN_MATCH_LABELS,
  KMC_ANN_MEMBER_VMS,
  KMC_BACKEND_LABEL_SELECTOR,
  KMC_LABEL_BACKEND_GROUP,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_TARGET_KIND,
  KMC_LABEL_VM,
  KMC_MAX_BACKEND_GROUP_VMS,
  KMC_RESOURCE_BACKEND,
} from "~/lib/k8s/constants";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { toResourceYaml } from "~/lib/k8s/yaml.server";
import { listClusters } from "~/vms/vms.server";
import {
  labelsMatchSelector,
  membershipAnnotations,
  membershipFromServiceMeta,
  membershipLabels,
  resolveServiceSelector,
  singleVmMembership,
} from "./membership";
import {
  listVmsWithBackendGroup,
  stampBackendGroup,
  unstampBackendGroup,
} from "./stamp.server";
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
    externalTrafficPolicy?: string;
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
  const membership = membershipFromServiceMeta(
    svc.metadata?.labels,
    svc.metadata?.annotations,
  );
  return {
    cluster,
    namespace: svc.metadata?.namespace ?? "default",
    name: svc.metadata?.name ?? "unknown",
    serviceType: svc.spec?.type ?? "ClusterIP",
    externalTrafficPolicy: svc.spec?.externalTrafficPolicy,
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

function validateMembership(membership: BackendMembership): void {
  if (membership.mode === "single-vm") {
    if (!membership.vmName?.trim()) throw new Error("target VM is required");
    return;
  }
  if (membership.mode === "labels") {
    if (!membership.matchLabels || Object.keys(membership.matchLabels).length === 0) {
      throw new Error("at least one match label is required");
    }
    return;
  }
  if (membership.mode === "group") {
    if (!membership.groupId?.trim()) throw new Error("group id is required");
    if (!membership.vmNames?.length) {
      throw new Error("select at least one VM for the group");
    }
    if (membership.vmNames.length > KMC_MAX_BACKEND_GROUP_VMS) {
      throw new Error(
        `at most ${KMC_MAX_BACKEND_GROUP_VMS} VMs per backend group`,
      );
    }
  }
}

/**
 * List VMs in a namespace whose pod-template labels match the selector.
 * Uses template labels (what virt-launcher carries) with metadata as fallback.
 */
export async function listVmsMatchingSelector(
  cluster: ClusterId,
  namespace: string,
  selector: Record<string, string>,
): Promise<BackendMatchedVm[]> {
  if (!selector || Object.keys(selector).length === 0) return [];

  const { custom } = getClusterClients(cluster);
  const res = (await custom.listNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace,
    plural: "virtualmachines",
  })) as {
    items?: Array<{
      metadata?: { name?: string; labels?: Record<string, string> };
      status?: { printableStatus?: string; ready?: boolean };
      spec?: {
        template?: {
          metadata?: { labels?: Record<string, string> };
          spec?: {
            networks?: Array<{ pod?: unknown; multus?: unknown }>;
          };
        };
      };
    }>;
  };

  const matched: BackendMatchedVm[] = [];
  for (const vm of res.items ?? []) {
    const name = vm.metadata?.name;
    if (!name) continue;
    const templateLabels = vm.spec?.template?.metadata?.labels;
    const metaLabels = vm.metadata?.labels;
    if (
      !labelsMatchSelector(templateLabels, selector) &&
      !labelsMatchSelector(metaLabels, selector)
    ) {
      continue;
    }
    const networks = vm.spec?.template?.spec?.networks ?? [];
    const podNetwork =
      networks.length === 0 ||
      networks.some((n) => n.pod != null && n.multus == null);
    const status = vm.status?.printableStatus ?? "Unknown";
    matched.push({
      name,
      status,
      ready: vm.status?.ready === true || status === "Running",
      podNetwork,
    });
  }
  matched.sort((a, b) => a.name.localeCompare(b.name));
  return matched;
}

/** Read pod-template labels for a VM (for multi-member reverse lookup). */
export async function getVmPodTemplateLabels(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<Record<string, string>> {
  const { custom } = getClusterClients(cluster);
  try {
    const vm = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name: vmName,
    })) as {
      metadata?: { labels?: Record<string, string> };
      spec?: {
        template?: { metadata?: { labels?: Record<string, string> } };
      };
    };
    return {
      ...(vm.metadata?.labels ?? {}),
      ...(vm.spec?.template?.metadata?.labels ?? {}),
      // kubevirt.io/vm is always on the virt-launcher pod
      "kubevirt.io/vm": vmName,
    };
  } catch (err) {
    if (isNotFound(err)) return { "kubevirt.io/vm": vmName };
    throw err;
  }
}

export async function createBackend(
  input: CreateBackendRequest,
): Promise<BackendSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!input.ports?.length) throw new Error("at least one port is required");

  validateMembership(input.membership);
  let membership = input.membership;

  // Normalize group: default groupId to backend Service name
  if (membership.mode === "group") {
    membership = {
      ...membership,
      groupId: membership.groupId.trim() || input.name,
      vmNames: [...new Set(membership.vmNames.map((n) => n.trim()).filter(Boolean))].sort(),
    };
  }

  if (membership.mode === "single-vm") {
    await ensureSingleVmExists(
      input.cluster,
      input.namespace,
      membership.vmName,
    );
  }

  if (membership.mode === "group") {
    await stampBackendGroup({
      cluster: input.cluster,
      namespace: input.namespace,
      groupId: membership.groupId,
      vmNames: membership.vmNames,
    });
  }

  const { core } = getClusterClients(input.cluster);

  try {
    await core.readNamespacedService({
      name: input.name,
      namespace: input.namespace,
    });
    // Service already exists — unstamp group if we just stamped
    if (membership.mode === "group") {
      try {
        await unstampBackendGroup({
          cluster: input.cluster,
          namespace: input.namespace,
          vmNames: membership.vmNames,
        });
      } catch {
        // ignore
      }
    }
    throw new Error(
      `Service "${input.namespace}/${input.name}" already exists`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("already exists")) {
      throw err;
    }
    if (!isNotFound(err)) {
      if (membership.mode === "group") {
        try {
          await unstampBackendGroup({
            cluster: input.cluster,
            namespace: input.namespace,
            vmNames: membership.vmNames,
          });
        } catch {
          // ignore
        }
      }
      throw new Error(formatError(err), { cause: err });
    }
  }

  const body = buildServiceManifest({ ...input, membership });

  try {
    const created = (await core.createNamespacedService({
      namespace: input.namespace,
      body: body as never,
    })) as KubeService;
    return mapSummary(input.cluster, created);
  } catch (err) {
    if (membership.mode === "group") {
      try {
        await unstampBackendGroup({
          cluster: input.cluster,
          namespace: input.namespace,
          vmNames: membership.vmNames,
        });
      } catch {
        // ignore
      }
    }
    throw new Error(`Failed to create Service: ${formatError(err)}`, {
      cause: err,
    });
  }
}

/**
 * Update ports and/or membership on an existing kmc backend Service.
 * For group membership, re-stamps VM labels (add new, unstamp removed).
 */
export async function updateBackend(
  input: UpdateBackendRequest,
): Promise<BackendSummary> {
  const { cluster, namespace, name } = input;
  if (!cluster?.trim() || !namespace?.trim() || !name?.trim()) {
    throw new Error("cluster, namespace, and name are required");
  }
  if (!input.membership && !input.ports) {
    throw new Error("nothing to update");
  }

  const existing = await readServiceOptional(cluster, namespace, name);
  if (!existing) {
    throw new Response("Backend Service not found", { status: 404 });
  }
  const labels = existing.metadata?.labels ?? {};
  if (labels[KMC_LABEL_RESOURCE] !== KMC_RESOURCE_BACKEND) {
    throw new Error(
      `Service "${namespace}/${name}" is not a kmc backend; not updating`,
    );
  }

  const prevMembership = membershipFromServiceMeta(
    existing.metadata?.labels,
    existing.metadata?.annotations,
  );

  let nextMembership = input.membership;
  if (nextMembership) {
    validateMembership(nextMembership);
    if (nextMembership.mode === "group") {
      nextMembership = {
        ...nextMembership,
        groupId: nextMembership.groupId.trim() || name,
        vmNames: [
          ...new Set(
            nextMembership.vmNames.map((n) => n.trim()).filter(Boolean),
          ),
        ].sort(),
      };
    }
    if (nextMembership.mode === "single-vm") {
      await ensureSingleVmExists(cluster, namespace, nextMembership.vmName);
    }
  }

  // Stamp group members before patching the Service selector
  if (nextMembership?.mode === "group") {
    const prevNames =
      prevMembership.mode === "group" ? prevMembership.vmNames : [];
    const nextNames = nextMembership.vmNames;
    const toAdd = nextNames.filter((n) => !prevNames.includes(n));
    const toRemove = prevNames.filter((n) => !nextNames.includes(n));
    if (toAdd.length > 0) {
      await stampBackendGroup({
        cluster,
        namespace,
        groupId: nextMembership.groupId,
        vmNames: toAdd,
      });
    }
    if (toRemove.length > 0) {
      await unstampBackendGroup({ cluster, namespace, vmNames: toRemove });
    }
    // Re-stamp remaining with current group id (no-op if already set)
    const keep = nextNames.filter((n) => prevNames.includes(n));
    if (keep.length > 0 && prevMembership.mode === "group") {
      if (prevMembership.groupId !== nextMembership.groupId) {
        await stampBackendGroup({
          cluster,
          namespace,
          groupId: nextMembership.groupId,
          vmNames: keep,
        });
      }
    }
  } else if (nextMembership && prevMembership.mode === "group") {
    // Leaving group mode — unstamp old members
    await unstampBackendGroup({
      cluster,
      namespace,
      vmNames: prevMembership.vmNames,
    });
  }

  const { core } = getClusterClients(cluster);
  const body = structuredClone(existing) as KubeService & Record<string, unknown>;
  delete (body as { status?: unknown }).status;

  body.metadata = body.metadata ?? {};
  body.metadata.labels = { ...(body.metadata.labels ?? {}) };
  body.metadata.annotations = { ...(body.metadata.annotations ?? {}) };
  body.spec = body.spec ?? {};

  if (nextMembership) {
    // Clear previous membership labels/annotations then apply new
    delete body.metadata.labels[KMC_LABEL_TARGET_KIND];
    delete body.metadata.labels[KMC_LABEL_VM];
    delete body.metadata.labels[KMC_LABEL_BACKEND_GROUP];
    delete body.metadata.annotations[KMC_ANN_MATCH_LABELS];
    delete body.metadata.annotations[KMC_ANN_MEMBER_VMS];

    Object.assign(body.metadata.labels, membershipLabels(nextMembership));
    Object.assign(
      body.metadata.annotations,
      membershipAnnotations(nextMembership),
    );
    body.spec.selector = resolveServiceSelector(nextMembership);
  }

  if (input.ports) {
    if (!input.ports.length) throw new Error("at least one port is required");
    for (const p of input.ports) {
      if (!Number.isFinite(p.port) || p.port < 1 || p.port > 65535) {
        throw new Error(`invalid service port: ${p.port}`);
      }
      if (!Number.isFinite(p.targetPort) || p.targetPort < 1 || p.targetPort > 65535) {
        throw new Error(`invalid target port: ${p.targetPort}`);
      }
    }
    body.spec.ports = input.ports.map((p, i) => ({
      name: p.name?.trim() || `port-${i}`,
      protocol: p.protocol ?? "TCP",
      port: p.port,
      targetPort: p.targetPort,
    }));
  }

  // Drop empty annotations object
  if (
    body.metadata.annotations &&
    Object.keys(body.metadata.annotations).length === 0
  ) {
    delete body.metadata.annotations;
  }

  try {
    await core.replaceNamespacedService({
      name,
      namespace,
      body: body as never,
    });
  } catch (err) {
    throw new Error(`Failed to update Service: ${formatError(err)}`, {
      cause: err,
    });
  }

  return getBackend(cluster, namespace, name);
}

export async function deleteBackend(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  const svc = await readServiceOptional(cluster, namespace, name);
  const membership = svc
    ? membershipFromServiceMeta(svc.metadata?.labels, svc.metadata?.annotations)
    : { mode: "unknown" as const };

  const { core } = getClusterClients(cluster);
  try {
    await core.deleteNamespacedService({ name, namespace });
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(formatError(err), { cause: err });
    }
  }

  // Clear group stamps after Service is gone
  if (membership.mode === "group") {
    const fromAnn = membership.vmNames;
    let names = fromAnn;
    try {
      const live = await listVmsWithBackendGroup(
        cluster,
        namespace,
        membership.groupId,
      );
      names = [...new Set([...fromAnn, ...live])].sort();
    } catch {
      // use annotation only
    }
    if (names.length > 0) {
      await unstampBackendGroup({ cluster, namespace, vmNames: names });
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

export interface BackendDetail extends BackendSummary {
  matchedVms: BackendMatchedVm[];
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export async function getBackendDetail(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<BackendDetail> {
  const svc = await readServiceOptional(cluster, namespace, name);
  if (!svc) {
    throw new Response("Backend Service not found", { status: 404 });
  }
  const endpoints = await readEndpointsCounts(cluster, namespace, name);
  const summary = mapSummary(cluster, svc, endpoints);
  const matchedVms = await listVmsMatchingSelector(
    cluster,
    namespace,
    summary.selector,
  ).catch(() => [] as BackendMatchedVm[]);
  return {
    ...summary,
    matchedVms,
    labels: svc.metadata?.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(svc.metadata?.annotations ?? {}).filter(
        ([k]) => !k.startsWith("kubectl.kubernetes.io/"),
      ),
    ),
  };
}

/** LoadBalancer-typed kmc backends only. */
export async function listLoadBalancers(clusterFilter?: ClusterId): Promise<{
  items: BackendSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const { items, clusters } = await listBackends(clusterFilter);
  return {
    items: items.filter((b) => b.serviceType === "LoadBalancer"),
    clusters,
  };
}

export async function createLoadBalancer(
  input: Omit<CreateBackendRequest, "serviceType">,
): Promise<BackendSummary> {
  return createBackend({ ...input, serviceType: "LoadBalancer" });
}

export async function getLoadBalancer(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<BackendDetail> {
  const detail = await getBackendDetail(cluster, namespace, name);
  if (detail.serviceType !== "LoadBalancer") {
    throw new Response("Load balancer not found", { status: 404 });
  }
  return detail;
}

export async function deleteLoadBalancer(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  const svc = await readServiceOptional(cluster, namespace, name);
  if (!svc) return;
  if ((svc.spec?.type ?? "ClusterIP") !== "LoadBalancer") {
    throw new Error(
      `Service "${namespace}/${name}" is not a LoadBalancer backend`,
    );
  }
  await deleteBackend(cluster, namespace, name);
}

export async function updateLoadBalancer(
  input: UpdateBackendRequest,
): Promise<BackendSummary> {
  const existing = await readServiceOptional(
    input.cluster,
    input.namespace,
    input.name,
  );
  if (!existing) {
    throw new Response("Load balancer not found", { status: 404 });
  }
  if ((existing.spec?.type ?? "ClusterIP") !== "LoadBalancer") {
    throw new Error(
      `Service "${input.namespace}/${input.name}" is not a LoadBalancer backend`,
    );
  }
  return updateBackend(input);
}

/** LoadBalancer backends that select this VM. */
export async function listLoadBalancersForVm(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<BackendSummary[]> {
  const all = await listBackendsForVm(cluster, namespace, vmName);
  return all.filter((b) => b.serviceType === "LoadBalancer");
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
        const svcs = (res.items ?? []) as KubeService[];
        // Endpoint readiness in parallel (list UX); ignore failures.
        const withEp = await Promise.all(
          svcs.map(async (svc) => {
            const ns = svc.metadata?.namespace ?? "default";
            const n = svc.metadata?.name ?? "";
            const endpoints = n
              ? await readEndpointsCounts(id, ns, n)
              : null;
            return mapSummary(id, svc, endpoints);
          }),
        );
        items.push(...withEp);
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

/** kmc backend Services that select a specific VM (any membership mode). */
export async function listBackendsForVm(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<BackendSummary[]> {
  const { core } = getClusterClients(cluster);
  const res = await core.listNamespacedService({
    namespace,
    labelSelector: KMC_BACKEND_LABEL_SELECTOR,
  });
  const vmLabels = await getVmPodTemplateLabels(cluster, namespace, vmName);
  const items: BackendSummary[] = [];
  for (const svc of (res.items ?? []) as KubeService[]) {
    const ns = svc.metadata?.namespace ?? namespace;
    const n = svc.metadata?.name ?? "";
    const endpoints = n ? await readEndpointsCounts(cluster, ns, n) : null;
    const summary = mapSummary(cluster, svc, endpoints);
    if (summary.membership.mode === "single-vm") {
      if (summary.membership.vmName === vmName) items.push(summary);
      continue;
    }
    if (labelsMatchSelector(vmLabels, summary.selector)) {
      items.push(summary);
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

export { singleVmMembership };
