import { formatError } from "~/lib/errors";
import type {
  ClusterId,
  CreateIngressRequest,
  IngressDetail,
  IngressRuleInfo,
  IngressSummary,
} from "~/lib/types";
import {
  KMC_INGRESS_LABEL_SELECTOR,
  KMC_LABEL_INGRESS,
  KMC_LABEL_TARGET_KIND,
  KMC_LABEL_VM,
  KMC_TARGET_KIND_GROUP,
  KMC_TARGET_KIND_LABELS,
  KMC_TARGET_KIND_VM,
} from "~/lib/k8s/constants";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { toResourceYaml } from "~/lib/k8s/yaml.server";
import {
  createBackend,
  deleteBackend,
  getVmPodTemplateLabels,
  listBackendsForVm,
  listVmsMatchingSelector,
  readEndpointsCounts,
  readServiceOptional,
} from "~/backends/backends.server";
import {
  labelsMatchSelector,
  membershipFromServiceMeta,
} from "~/backends/membership";
import { listClusters } from "~/vms/vms.server";
import {
  buildIngressManifest,
  vmNameFromIngressLabels,
} from "./template.server";

interface KubeIngress {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    ingressClassName?: string;
    rules?: Array<{
      host?: string;
      http?: {
        paths?: Array<{
          path?: string;
          pathType?: string;
          backend?: {
            service?: {
              name?: string;
              port?: { number?: number; name?: string };
            };
          };
        }>;
      };
    }>;
    tls?: Array<{ hosts?: string[]; secretName?: string }>;
  };
  status?: {
    loadBalancer?: {
      ingress?: Array<{ ip?: string; hostname?: string }>;
    };
  };
}

function mapHosts(ing: KubeIngress): string[] {
  const hosts = new Set<string>();
  for (const rule of ing.spec?.rules ?? []) {
    if (rule.host) hosts.add(rule.host);
  }
  for (const tls of ing.spec?.tls ?? []) {
    for (const h of tls.hosts ?? []) {
      if (h) hosts.add(h);
    }
  }
  return Array.from(hosts);
}

/**
 * Hosts that should use https. A TLS block with no hosts covers every rule host.
 */
function mapTlsHosts(ing: KubeIngress, allHosts: string[]): string[] {
  const explicit = new Set<string>();
  let coversAll = false;
  for (const tls of ing.spec?.tls ?? []) {
    const list = (tls.hosts ?? []).filter((h): h is string => Boolean(h));
    if (list.length === 0) {
      coversAll = true;
    } else {
      for (const h of list) explicit.add(h);
    }
  }
  if (!coversAll && explicit.size === 0) return [];
  if (coversAll) return allHosts;
  return allHosts.filter((h) => explicit.has(h));
}

function mapAddress(ing: KubeIngress): string | undefined {
  const lb = ing.status?.loadBalancer?.ingress?.[0];
  if (!lb) return undefined;
  return lb.hostname || lb.ip || undefined;
}

function mapRules(ing: KubeIngress): IngressRuleInfo[] {
  return (ing.spec?.rules ?? []).map((rule) => ({
    host: rule.host,
    paths: (rule.http?.paths ?? []).map((p) => ({
      path: p.path ?? "/",
      pathType: p.pathType ?? "Prefix",
      serviceName: p.backend?.service?.name ?? "",
      servicePort:
        p.backend?.service?.port?.number ??
        p.backend?.service?.port?.name ??
        "",
    })),
  }));
}

function primaryServiceName(ing: KubeIngress): string | undefined {
  for (const rule of mapRules(ing)) {
    for (const path of rule.paths) {
      if (path.serviceName) return path.serviceName;
    }
  }
  // v1 convention: companion Service shares the Ingress name
  return ing.metadata?.name;
}

function membershipModeFromKind(
  kind: string | undefined,
): IngressSummary["membershipMode"] {
  if (kind === KMC_TARGET_KIND_VM) return "single-vm";
  if (kind === KMC_TARGET_KIND_LABELS) return "labels";
  if (kind === KMC_TARGET_KIND_GROUP) return "group";
  if (!kind) return "single-vm"; // older single-vm creates without resource=ingress may still have vm label
  return "unknown";
}

function mapSummary(cluster: ClusterId, ing: KubeIngress): IngressSummary {
  const hosts = mapHosts(ing);
  const labels = ing.metadata?.labels;
  const kind = labels?.[KMC_LABEL_TARGET_KIND];
  const membershipMode = membershipModeFromKind(kind);
  const vmName =
    membershipMode === "single-vm"
      ? vmNameFromIngressLabels(labels)
      : undefined;
  return {
    cluster,
    namespace: ing.metadata?.namespace ?? "default",
    name: ing.metadata?.name ?? "unknown",
    hosts,
    tlsHosts: mapTlsHosts(ing, hosts),
    className: ing.spec?.ingressClassName,
    membershipMode,
    vmName,
    serviceName: primaryServiceName(ing),
    age: ing.metadata?.creationTimestamp ?? "",
    address: mapAddress(ing),
  };
}

function isNotFound(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  return message.includes("404") || message.includes("not found");
}

async function vmBindingInfo(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<{ name: string; exists: boolean; podNetwork: boolean }> {
  try {
    const { custom } = getClusterClients(cluster);
    const vm = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name: vmName,
    })) as {
      spec?: {
        template?: {
          spec?: {
            networks?: Array<{ pod?: unknown; multus?: unknown }>;
          };
        };
      };
    };
    const networks = vm.spec?.template?.spec?.networks ?? [];
    const podNetwork =
      networks.length === 0 ||
      networks.some((n) => n.pod != null && n.multus == null);
    return { name: vmName, exists: true, podNetwork };
  } catch (err) {
    if (isNotFound(err)) {
      return { name: vmName, exists: false, podNetwork: false };
    }
    // Treat unexpected errors as "exists unknown" — still show the link
    return { name: vmName, exists: true, podNetwork: true };
  }
}

export async function listIngresses(clusterFilter?: ClusterId): Promise<{
  items: IngressSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const contexts = clusterFilter ? [clusterFilter] : getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const items: IngressSummary[] = [];

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const { networking } = getClusterClients(id);
        const res = await networking.listIngressForAllNamespaces({
          labelSelector: KMC_INGRESS_LABEL_SELECTOR,
        });
        for (const ing of (res.items ?? []) as KubeIngress[]) {
          items.push(mapSummary(id, ing));
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

/**
 * kmc-managed Ingresses that target a VM — single-vm label, or multi-member
 * backends whose selector matches the VM's pod-template labels.
 */
export async function listIngressesForVm(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<IngressSummary[]> {
  const { networking } = getClusterClients(cluster);
  const byName = new Map<string, IngressSummary>();

  // 1. Direct single-vm Ingress labels
  try {
    const res = await networking.listNamespacedIngress({
      namespace,
      labelSelector: `${KMC_INGRESS_LABEL_SELECTOR},${KMC_LABEL_VM}=${vmName}`,
    });
    for (const ing of (res.items ?? []) as KubeIngress[]) {
      const s = mapSummary(cluster, ing);
      byName.set(s.name, s);
    }
  } catch {
    // fall through to multi-member path
  }

  // 2. Multi-member: backends selecting this VM → Ingresses pointing at them
  try {
    const backends = await listBackendsForVm(cluster, namespace, vmName);
    const serviceNames = new Set(backends.map((b) => b.name));
    if (serviceNames.size > 0) {
      const all = await networking.listNamespacedIngress({
        namespace,
        labelSelector: KMC_INGRESS_LABEL_SELECTOR,
      });
      const vmLabels = await getVmPodTemplateLabels(cluster, namespace, vmName);
      for (const ing of (all.items ?? []) as KubeIngress[]) {
        const s = mapSummary(cluster, ing);
        const svcName = s.serviceName ?? s.name;
        if (!serviceNames.has(svcName)) continue;
        // Confirm selector still matches (backend list already filtered)
        const backend = backends.find((b) => b.name === svcName);
        if (backend && !labelsMatchSelector(vmLabels, backend.selector)) {
          continue;
        }
        byName.set(s.name, s);
      }
    }
  } catch {
    // keep single-vm results
  }

  const items = Array.from(byName.values());
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

export async function getIngress(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<IngressDetail> {
  const { networking } = getClusterClients(cluster);
  let ing: KubeIngress;
  try {
    ing = (await networking.readNamespacedIngress({
      name,
      namespace,
    })) as KubeIngress;
  } catch (err) {
    if (isNotFound(err)) {
      throw new Response("Ingress not found", { status: 404 });
    }
    throw new Error(formatError(err), { cause: err });
  }

  const summary = mapSummary(cluster, ing);
  const serviceName = summary.serviceName ?? name;
  const [service, endpoints] = await Promise.all([
    readServiceOptional(cluster, namespace, serviceName),
    readEndpointsCounts(cluster, namespace, serviceName),
  ]);

  const membership = membershipFromServiceMeta(
    service?.metadata?.labels,
    service?.metadata?.annotations,
  );
  const selector = service?.spec?.selector ?? {};
  const backendVmName =
    membership.mode === "single-vm" ? membership.vmName : undefined;
  const targetVmName = summary.vmName ?? backendVmName;

  const [vm, matchedVms] = await Promise.all([
    targetVmName
      ? vmBindingInfo(cluster, namespace, targetVmName)
      : Promise.resolve(undefined),
    service && Object.keys(selector).length > 0
      ? listVmsMatchingSelector(cluster, namespace, selector).catch(() => [])
      : Promise.resolve([]),
  ]);

  return {
    ...summary,
    vmName: targetVmName,
    uid: ing.metadata?.uid,
    labels: ing.metadata?.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(ing.metadata?.annotations ?? {}).filter(
        ([k]) => !k.startsWith("kubectl.kubernetes.io/"),
      ),
    ),
    rules: mapRules(ing),
    tls: (ing.spec?.tls ?? []).map((t) => ({
      hosts: t.hosts ?? [],
      secretName: t.secretName,
    })),
    servicePorts: (service?.spec?.ports ?? []).map((p) => ({
      name: p.name,
      port: p.port ?? 0,
      targetPort: p.targetPort ?? p.port ?? 0,
      protocol: p.protocol,
    })),
    endpointsReady: endpoints?.ready,
    endpointsTotal: endpoints?.total,
    backend: service
      ? {
          exists: true,
          serviceType: service.spec?.type ?? "ClusterIP",
          membership,
          selector,
          matchedVms,
        }
      : {
          exists: false,
          membership: { mode: "unknown" as const },
          selector: {},
          matchedVms: [],
        },
    vm,
  };
}

export async function getIngressYaml(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<string> {
  const { networking, core } = getClusterClients(cluster);
  const [ing, service] = await Promise.all([
    networking.readNamespacedIngress({ name, namespace }),
    core.readNamespacedService({ name, namespace }).catch(() => null),
  ]);

  const parts = [toResourceYaml(ing)];
  if (service) {
    parts.push("---\n" + toResourceYaml(service).trimStart());
  }
  return parts.join("\n");
}

export async function createIngress(
  input: CreateIngressRequest,
): Promise<IngressSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!input.membership) throw new Error("backend membership is required");
  if (!input.host?.trim()) throw new Error("host is required");

  // Normalize group id to ingress/backend name when empty
  let membership = input.membership;
  if (membership.mode === "group") {
    membership = {
      ...membership,
      groupId: membership.groupId.trim() || input.name,
    };
  }

  const { networking } = getClusterClients(input.cluster);

  // Pre-check Ingress name collision (backend create checks Service)
  try {
    await networking.readNamespacedIngress({
      name: input.name,
      namespace: input.namespace,
    });
    throw new Error(
      `Ingress "${input.namespace}/${input.name}" already exists`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("already exists")) {
      throw err;
    }
    if (!isNotFound(err)) {
      throw new Error(formatError(err), { cause: err });
    }
  }

  const servicePort = input.servicePort ?? 80;
  const targetPort = input.targetPort ?? servicePort;
  const payload: CreateIngressRequest = { ...input, membership };

  // Companion backend Service (selector + ports); VM existence / group stamp inside
  await createBackend({
    cluster: input.cluster,
    namespace: input.namespace,
    name: input.name,
    membership,
    ports: [
      {
        name: "http",
        port: servicePort,
        targetPort,
        protocol: "TCP",
      },
    ],
    serviceType: "ClusterIP",
    extraLabels: {
      [KMC_LABEL_INGRESS]: input.name,
    },
  });

  const ingressBody = buildIngressManifest(payload, input.name);

  try {
    const created = (await networking.createNamespacedIngress({
      namespace: input.namespace,
      body: ingressBody as never,
    })) as KubeIngress;
    return mapSummary(input.cluster, created);
  } catch (err) {
    // Best-effort rollback of companion backend Service (unstamps group)
    try {
      await deleteBackend(input.cluster, input.namespace, input.name);
    } catch {
      // ignore
    }
    throw new Error(`Failed to create Ingress: ${formatError(err)}`, {
      cause: err,
    });
  }
}

export async function deleteIngress(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  const { networking } = getClusterClients(cluster);

  try {
    await networking.deleteNamespacedIngress({ name, namespace });
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(formatError(err), { cause: err });
    }
  }

  try {
    await deleteBackend(cluster, namespace, name);
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(
        `Ingress deleted but Service cleanup failed: ${formatError(err)}`,
        { cause: err },
      );
    }
  }
}

/** Lightweight VM list for the create form picker. */
export async function listVmOptionsForNamespace(
  cluster: ClusterId,
  namespace: string,
): Promise<
  Array<{ name: string; status: string; podNetwork: boolean; ready: boolean }>
> {
  const { custom } = getClusterClients(cluster);
  const res = (await custom.listNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace,
    plural: "virtualmachines",
  })) as {
    items?: Array<{
      metadata?: { name?: string };
      status?: { printableStatus?: string; ready?: boolean };
      spec?: {
        template?: {
          spec?: {
            networks?: Array<{ pod?: unknown; multus?: unknown }>;
          };
        };
      };
    }>;
  };

  return (res.items ?? [])
    .map((vm) => {
      const networks = vm.spec?.template?.spec?.networks ?? [];
      const podNetwork =
        networks.length === 0 ||
        networks.some((n) => n.pod != null && n.multus == null);
      const status = vm.status?.printableStatus ?? "Unknown";
      return {
        name: vm.metadata?.name ?? "unknown",
        status,
        podNetwork,
        ready: vm.status?.ready === true || status === "Running",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
