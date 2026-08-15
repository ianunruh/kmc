import { formatError } from "~/lib/errors";
import type {
  ClusterId,
  CreateHttpRouteRequest,
  GatewayOption,
  HttpRouteDetail,
  HttpRouteParentRef,
  HttpRoutePathType,
  HttpRouteRuleInfo,
  HttpRouteSummary,
  UpdateHttpRouteRequest,
} from "~/lib/types";
import {
  GATEWAY_API_GROUP,
  GATEWAY_API_VERSION,
  GATEWAY_PLURAL,
  HTTP_ROUTE_PLURAL,
  KMC_HTTP_ROUTE_LABEL_SELECTOR,
  KMC_LABEL_HTTP_ROUTE,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_TARGET_KIND,
  KMC_LABEL_VM,
  KMC_RESOURCE_BACKEND,
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
  updateBackend,
} from "~/backends/backends.server";
import {
  labelsMatchSelector,
  membershipFromServiceMeta,
} from "~/backends/membership";
import { listClusters } from "~/vms/vms.server";
import {
  buildHttpRouteManifest,
  ownershipLabels,
  vmNameFromHttpRouteLabels,
} from "./template.server";

interface KubeParentRef {
  group?: string;
  kind?: string;
  name?: string;
  namespace?: string;
  sectionName?: string;
}

interface KubeHttpRoute {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    parentRefs?: KubeParentRef[];
    hostnames?: string[];
    rules?: Array<{
      matches?: Array<{
        path?: { type?: string; value?: string };
      }>;
      backendRefs?: Array<{
        name?: string;
        namespace?: string;
        port?: number;
      }>;
    }>;
  };
  status?: {
    parents?: Array<{
      parentRef?: KubeParentRef;
      conditions?: Array<{ type?: string; status?: string }>;
    }>;
  };
}

interface KubeGateway {
  metadata?: {
    name?: string;
    namespace?: string;
  };
  spec?: {
    gatewayClassName?: string;
    listeners?: Array<{
      name?: string;
      protocol?: string;
      port?: number;
      hostname?: string;
    }>;
  };
  status?: {
    addresses?: Array<{ type?: string; value?: string }>;
  };
}

function mapParentRefs(route: KubeHttpRoute): HttpRouteParentRef[] {
  return (route.spec?.parentRefs ?? [])
    .filter((p): p is KubeParentRef & { name: string } => Boolean(p.name))
    .map((p) => ({
      name: p.name,
      namespace: p.namespace,
      sectionName: p.sectionName,
      kind: p.kind,
    }));
}

function mapHosts(route: KubeHttpRoute): string[] {
  return (route.spec?.hostnames ?? []).filter((h): h is string => Boolean(h));
}

function parentAccepted(route: KubeHttpRoute): boolean | undefined {
  const parents = route.status?.parents ?? [];
  if (parents.length === 0) return undefined;
  return parents.some((p) =>
    (p.conditions ?? []).some(
      (c) => c.type === "Accepted" && c.status === "True",
    ),
  );
}

function mapRules(route: KubeHttpRoute): HttpRouteRuleInfo[] {
  return (route.spec?.rules ?? []).map((rule) => {
    const backend = rule.backendRefs?.[0];
    const matches = rule.matches ?? [];
    const rows =
      matches.length > 0
        ? matches
        : [{ path: { type: "PathPrefix", value: "/" } }];
    return {
      matches: rows.map((m) => ({
        path: m.path?.value ?? "/",
        pathType: m.path?.type ?? "PathPrefix",
        serviceName: backend?.name ?? "",
        servicePort: backend?.port ?? "",
      })),
    };
  });
}

function primaryServiceName(route: KubeHttpRoute): string | undefined {
  for (const rule of mapRules(route)) {
    for (const match of rule.matches) {
      if (match.serviceName) return match.serviceName;
    }
  }
  return route.metadata?.name;
}

function membershipModeFromKind(
  kind: string | undefined,
): HttpRouteSummary["membershipMode"] {
  if (kind === KMC_TARGET_KIND_VM) return "single-vm";
  if (kind === KMC_TARGET_KIND_LABELS) return "labels";
  if (kind === KMC_TARGET_KIND_GROUP) return "group";
  if (!kind) return "single-vm";
  return "unknown";
}

function gatewayKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

function parentGatewayKey(
  routeNs: string,
  parent: HttpRouteParentRef,
): string {
  return gatewayKey(parent.namespace || routeNs, parent.name);
}

function listenerIsHttps(protocol: string | undefined): boolean {
  const p = (protocol ?? "").toUpperCase();
  return p === "HTTPS" || p === "TLS";
}

function httpsHostsForRoute(
  route: KubeHttpRoute,
  gateways: Map<string, KubeGateway>,
): string[] {
  const hosts = mapHosts(route);
  if (hosts.length === 0) return [];
  const routeNs = route.metadata?.namespace ?? "";
  const https = new Set<string>();
  for (const parent of mapParentRefs(route)) {
    const gw = gateways.get(parentGatewayKey(routeNs, parent));
    const listeners = gw?.spec?.listeners ?? [];
    const relevant = parent.sectionName
      ? listeners.filter((l) => l.name === parent.sectionName)
      : listeners;
    if (relevant.some((l) => listenerIsHttps(l.protocol))) {
      for (const h of hosts) https.add(h);
    }
  }
  return Array.from(https);
}

function addressForRoute(
  route: KubeHttpRoute,
  gateways: Map<string, KubeGateway>,
): string | undefined {
  const routeNs = route.metadata?.namespace ?? "";
  for (const parent of mapParentRefs(route)) {
    const gw = gateways.get(parentGatewayKey(routeNs, parent));
    const addr = gw?.status?.addresses?.[0]?.value;
    if (addr) return addr;
  }
  return undefined;
}

function mapSummary(
  cluster: ClusterId,
  route: KubeHttpRoute,
  gateways: Map<string, KubeGateway> = new Map(),
): HttpRouteSummary {
  const hosts = mapHosts(route);
  const labels = route.metadata?.labels;
  const kind = labels?.[KMC_LABEL_TARGET_KIND];
  const membershipMode = membershipModeFromKind(kind);
  const vmName =
    membershipMode === "single-vm"
      ? vmNameFromHttpRouteLabels(labels)
      : undefined;
  return {
    cluster,
    namespace: route.metadata?.namespace ?? "default",
    name: route.metadata?.name ?? "unknown",
    hosts,
    httpsHosts: httpsHostsForRoute(route, gateways),
    parentRefs: mapParentRefs(route),
    accepted: parentAccepted(route),
    membershipMode,
    vmName,
    serviceName: primaryServiceName(route),
    age: route.metadata?.creationTimestamp ?? "",
    address: addressForRoute(route, gateways),
  };
}

function isNotFound(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  return message.includes("404") || message.includes("not found");
}

function gatewayApi(cluster: ClusterId) {
  const { custom, core } = getClusterClients(cluster);
  return { custom, core };
}

async function listClusterHttpRoutes(
  cluster: ClusterId,
  labelSelector?: string,
): Promise<KubeHttpRoute[]> {
  const { custom } = gatewayApi(cluster);
  const res = (await custom.listClusterCustomObject({
    group: GATEWAY_API_GROUP,
    version: GATEWAY_API_VERSION,
    plural: HTTP_ROUTE_PLURAL,
    ...(labelSelector ? { labelSelector } : {}),
  })) as { items?: KubeHttpRoute[] };
  return res.items ?? [];
}

async function listNamespacedHttpRoutes(
  cluster: ClusterId,
  namespace: string,
  labelSelector?: string,
): Promise<KubeHttpRoute[]> {
  const { custom } = gatewayApi(cluster);
  const res = (await custom.listNamespacedCustomObject({
    group: GATEWAY_API_GROUP,
    version: GATEWAY_API_VERSION,
    namespace,
    plural: HTTP_ROUTE_PLURAL,
    ...(labelSelector ? { labelSelector } : {}),
  })) as { items?: KubeHttpRoute[] };
  return res.items ?? [];
}

async function readHttpRoute(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<KubeHttpRoute> {
  const { custom } = gatewayApi(cluster);
  return (await custom.getNamespacedCustomObject({
    group: GATEWAY_API_GROUP,
    version: GATEWAY_API_VERSION,
    namespace,
    plural: HTTP_ROUTE_PLURAL,
    name,
  })) as KubeHttpRoute;
}

async function listClusterGateways(
  cluster: ClusterId,
): Promise<KubeGateway[]> {
  const { custom } = gatewayApi(cluster);
  const res = (await custom.listClusterCustomObject({
    group: GATEWAY_API_GROUP,
    version: GATEWAY_API_VERSION,
    plural: GATEWAY_PLURAL,
  })) as { items?: KubeGateway[] };
  return res.items ?? [];
}

function gatewayMap(gateways: KubeGateway[]): Map<string, KubeGateway> {
  const map = new Map<string, KubeGateway>();
  for (const gw of gateways) {
    const name = gw.metadata?.name;
    const ns = gw.metadata?.namespace;
    if (!name || !ns) continue;
    map.set(gatewayKey(ns, name), gw);
  }
  return map;
}

function mapGatewayOption(cluster: ClusterId, gw: KubeGateway): GatewayOption | null {
  const name = gw.metadata?.name;
  const namespace = gw.metadata?.namespace;
  if (!name || !namespace) return null;
  return {
    cluster,
    namespace,
    name,
    gatewayClassName: gw.spec?.gatewayClassName,
    listeners: (gw.spec?.listeners ?? [])
      .filter((l): l is { name: string; protocol: string; port: number; hostname?: string } =>
        Boolean(l.name && l.protocol && l.port != null),
      )
      .map((l) => ({
        name: l.name,
        protocol: l.protocol,
        port: l.port,
        hostname: l.hostname,
      })),
    addresses: (gw.status?.addresses ?? [])
      .map((a) => a.value)
      .filter((v): v is string => Boolean(v)),
  };
}

export async function listGateways(cluster: ClusterId): Promise<GatewayOption[]> {
  try {
    const items = await listClusterGateways(cluster);
    return items
      .map((gw) => mapGatewayOption(cluster, gw))
      .filter((g): g is GatewayOption => g != null)
      .sort((a, b) => {
        const n = a.namespace.localeCompare(b.namespace);
        if (n) return n;
        return a.name.localeCompare(b.name);
      });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
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
    return { name: vmName, exists: true, podNetwork: true };
  }
}

export async function listHttpRoutes(clusterFilter?: ClusterId): Promise<{
  items: HttpRouteSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const contexts = clusterFilter ? [clusterFilter] : getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const items: HttpRouteSummary[] = [];

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const [routes, gateways] = await Promise.all([
          listClusterHttpRoutes(id, KMC_HTTP_ROUTE_LABEL_SELECTOR),
          listClusterGateways(id).catch(() => [] as KubeGateway[]),
        ]);
        const gwMap = gatewayMap(gateways);
        const mapped = await Promise.all(
          routes.map(async (route) => {
            const s = mapSummary(id, route, gwMap);
            const svcName = s.serviceName ?? s.name;
            const endpoints = await readEndpointsCounts(
              id,
              s.namespace,
              svcName,
            );
            if (endpoints) {
              s.endpointsReady = endpoints.ready;
              s.endpointsTotal = endpoints.total;
            }
            return s;
          }),
        );
        items.push(...mapped);
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
 * kmc-managed HTTPRoutes that target a VM — single-vm label, or multi-member
 * backends whose selector matches the VM's pod-template labels.
 */
export async function listHttpRoutesForVm(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<HttpRouteSummary[]> {
  const byName = new Map<string, HttpRouteSummary>();
  const gateways = await listClusterGateways(cluster).catch(() => [] as KubeGateway[]);
  const gwMap = gatewayMap(gateways);

  try {
    const routes = await listNamespacedHttpRoutes(
      cluster,
      namespace,
      `${KMC_HTTP_ROUTE_LABEL_SELECTOR},${KMC_LABEL_VM}=${vmName}`,
    );
    for (const route of routes) {
      const s = mapSummary(cluster, route, gwMap);
      byName.set(s.name, s);
    }
  } catch {
    // fall through to multi-member path
  }

  try {
    const backends = await listBackendsForVm(cluster, namespace, vmName);
    const serviceNames = new Set(backends.map((b) => b.name));
    if (serviceNames.size > 0) {
      const all = await listNamespacedHttpRoutes(
        cluster,
        namespace,
        KMC_HTTP_ROUTE_LABEL_SELECTOR,
      );
      const vmLabels = await getVmPodTemplateLabels(cluster, namespace, vmName);
      for (const route of all) {
        const s = mapSummary(cluster, route, gwMap);
        const svcName = s.serviceName ?? s.name;
        if (!serviceNames.has(svcName)) continue;
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
  await Promise.all(
    items.map(async (s) => {
      const svcName = s.serviceName ?? s.name;
      const endpoints = await readEndpointsCounts(cluster, namespace, svcName);
      if (endpoints) {
        s.endpointsReady = endpoints.ready;
        s.endpointsTotal = endpoints.total;
      }
    }),
  );
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

export async function getHttpRoute(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<HttpRouteDetail> {
  let route: KubeHttpRoute;
  try {
    route = await readHttpRoute(cluster, namespace, name);
  } catch (err) {
    if (isNotFound(err)) {
      throw new Response("HTTPRoute not found", { status: 404 });
    }
    throw new Error(formatError(err), { cause: err });
  }

  const gateways = await listClusterGateways(cluster).catch(() => [] as KubeGateway[]);
  const summary = mapSummary(cluster, route, gatewayMap(gateways));
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
    uid: route.metadata?.uid,
    labels: route.metadata?.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(route.metadata?.annotations ?? {}).filter(
        ([k]) => !k.startsWith("kubectl.kubernetes.io/"),
      ),
    ),
    rules: mapRules(route),
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

export async function getHttpRouteYaml(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<string> {
  const { custom, core } = gatewayApi(cluster);
  const [route, service] = await Promise.all([
    custom.getNamespacedCustomObject({
      group: GATEWAY_API_GROUP,
      version: GATEWAY_API_VERSION,
      namespace,
      plural: HTTP_ROUTE_PLURAL,
      name,
    }),
    core.readNamespacedService({ name, namespace }).catch(() => null),
  ]);

  const parts = [toResourceYaml(route)];
  if (service) {
    parts.push("---\n" + toResourceYaml(service).trimStart());
  }
  return parts.join("\n");
}

export async function createHttpRoute(
  input: CreateHttpRouteRequest,
): Promise<HttpRouteSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!input.host?.trim()) throw new Error("host is required");
  if (!input.gatewayName?.trim()) throw new Error("parent Gateway is required");

  const existingService = input.existingServiceName?.trim();
  if (!existingService && !input.membership) {
    throw new Error("backend membership is required (or pick an existing Service)");
  }

  let membership = input.membership;
  if (membership?.mode === "group") {
    membership = {
      ...membership,
      groupId: membership.groupId.trim() || input.name,
    };
  }

  const { custom, core } = gatewayApi(input.cluster);

  try {
    await readHttpRoute(input.cluster, input.namespace, input.name);
    throw new Error(
      `HTTPRoute "${input.namespace}/${input.name}" already exists`,
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
  const payload: CreateHttpRouteRequest = { ...input, membership };
  let createdCompanion = false;

  if (existingService) {
    try {
      await core.readNamespacedService({
        name: existingService,
        namespace: input.namespace,
      });
    } catch (err) {
      if (isNotFound(err)) {
        throw new Error(
          `Service "${input.namespace}/${existingService}" not found`,
        );
      }
      throw new Error(formatError(err), { cause: err });
    }
  } else if (membership) {
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
        [KMC_LABEL_HTTP_ROUTE]: input.name,
      },
    });
    createdCompanion = true;
  }

  const body = buildHttpRouteManifest(
    payload,
    existingService || input.name,
  );

  try {
    const created = (await custom.createNamespacedCustomObject({
      group: GATEWAY_API_GROUP,
      version: GATEWAY_API_VERSION,
      namespace: input.namespace,
      plural: HTTP_ROUTE_PLURAL,
      body,
    })) as KubeHttpRoute;
    const gateways = await listClusterGateways(input.cluster).catch(
      () => [] as KubeGateway[],
    );
    return mapSummary(input.cluster, created, gatewayMap(gateways));
  } catch (err) {
    if (createdCompanion) {
      try {
        await deleteBackend(input.cluster, input.namespace, input.name);
      } catch {
        // ignore
      }
    }
    throw new Error(`Failed to create HTTPRoute: ${formatError(err)}`, {
      cause: err,
    });
  }
}

/**
 * Update HTTPRoute host/path/parent and optionally companion backend ports/membership.
 */
export async function updateHttpRoute(
  input: UpdateHttpRouteRequest,
): Promise<HttpRouteDetail> {
  const { cluster, namespace, name } = input;
  if (!cluster?.trim() || !namespace?.trim() || !name?.trim()) {
    throw new Error("cluster, namespace, and name are required");
  }

  const { custom } = gatewayApi(cluster);
  let existing: KubeHttpRoute;
  try {
    existing = await readHttpRoute(cluster, namespace, name);
  } catch (err) {
    if (isNotFound(err)) {
      throw new Response("HTTPRoute not found", { status: 404 });
    }
    throw new Error(formatError(err), { cause: err });
  }

  const body = structuredClone(existing) as KubeHttpRoute & Record<string, unknown>;
  delete (body as { status?: unknown }).status;
  body.metadata = body.metadata ?? {};
  body.metadata.labels = { ...(body.metadata.labels ?? {}) };
  body.spec = body.spec ?? {};

  const currentHost = mapHosts(existing)[0] || "";
  const host = input.host !== undefined ? input.host.trim() : currentHost;
  if (!host) throw new Error("host is required");

  const currentRule = existing.spec?.rules?.[0];
  const currentMatch = currentRule?.matches?.[0];
  const path =
    input.path !== undefined
      ? input.path.trim() || "/"
      : (currentMatch?.path?.value ?? "/");
  const pathType: HttpRoutePathType =
    input.pathType ??
    ((currentMatch?.path?.type as HttpRoutePathType | undefined) || "PathPrefix");
  const serviceName =
    currentRule?.backendRefs?.[0]?.name || name;
  const currentPort = currentRule?.backendRefs?.[0]?.port ?? 80;
  const servicePort =
    input.servicePort !== undefined ? input.servicePort : currentPort;

  if (input.membership) {
    const owned = ownershipLabels({ name, membership: input.membership });
    Object.assign(body.metadata.labels, owned);
  }

  const currentParent = existing.spec?.parentRefs?.[0];
  const gatewayName =
    input.gatewayName !== undefined
      ? input.gatewayName.trim()
      : (currentParent?.name ?? "");
  if (!gatewayName) throw new Error("parent Gateway is required");
  const gatewayNamespace =
    input.gatewayNamespace !== undefined
      ? input.gatewayNamespace?.trim() || undefined
      : currentParent?.namespace;
  const sectionName =
    input.sectionName !== undefined
      ? input.sectionName?.trim() || undefined
      : currentParent?.sectionName;

  body.spec.parentRefs = [
    {
      group: GATEWAY_API_GROUP,
      kind: "Gateway",
      name: gatewayName,
      ...(gatewayNamespace ? { namespace: gatewayNamespace } : {}),
      ...(sectionName ? { sectionName } : {}),
    },
  ];
  body.spec.hostnames = [host];
  body.spec.rules = [
    {
      matches: [
        {
          path: {
            type: pathType,
            value: path,
          },
        },
      ],
      backendRefs: [
        {
          name: serviceName,
          port: servicePort,
        },
      ],
    },
  ];

  try {
    await custom.replaceNamespacedCustomObject({
      group: GATEWAY_API_GROUP,
      version: GATEWAY_API_VERSION,
      namespace,
      plural: HTTP_ROUTE_PLURAL,
      name,
      body,
    });
  } catch (err) {
    throw new Error(`Failed to update HTTPRoute: ${formatError(err)}`, {
      cause: err,
    });
  }

  const ownsCompanion =
    serviceName === name ||
    (await readServiceOptional(cluster, namespace, serviceName))?.metadata
      ?.labels?.[KMC_LABEL_HTTP_ROUTE] === name;

  if (
    ownsCompanion &&
    (input.membership ||
      input.targetPort !== undefined ||
      input.servicePort !== undefined)
  ) {
    const svc = await readServiceOptional(cluster, namespace, serviceName);
    if (
      svc?.metadata?.labels?.[KMC_LABEL_RESOURCE] === KMC_RESOURCE_BACKEND
    ) {
      const ports =
        input.targetPort !== undefined || input.servicePort !== undefined
          ? [
              {
                name: "http",
                port: servicePort,
                targetPort:
                  input.targetPort ??
                  (typeof svc.spec?.ports?.[0]?.targetPort === "number"
                    ? svc.spec.ports[0].targetPort
                    : servicePort),
                protocol: "TCP" as const,
              },
            ]
          : undefined;
      await updateBackend({
        cluster,
        namespace,
        name: serviceName,
        membership: input.membership,
        ports,
      });
    }
  }

  return getHttpRoute(cluster, namespace, name);
}

export async function deleteHttpRoute(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  const { custom } = gatewayApi(cluster);

  let serviceName = name;
  try {
    const route = await readHttpRoute(cluster, namespace, name);
    serviceName = primaryServiceName(route) ?? name;
  } catch {
    // continue with name convention
  }

  try {
    await custom.deleteNamespacedCustomObject({
      group: GATEWAY_API_GROUP,
      version: GATEWAY_API_VERSION,
      namespace,
      plural: HTTP_ROUTE_PLURAL,
      name,
    });
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(formatError(err), { cause: err });
    }
  }

  const svc = await readServiceOptional(cluster, namespace, serviceName);
  if (!svc) return;
  const labels = svc.metadata?.labels ?? {};
  const isBackend = labels[KMC_LABEL_RESOURCE] === KMC_RESOURCE_BACKEND;
  const ownedByRoute =
    labels[KMC_LABEL_HTTP_ROUTE] === name || serviceName === name;
  if (!isBackend || !ownedByRoute) return;
  if (
    labels[KMC_LABEL_HTTP_ROUTE] !== name &&
    (svc.spec?.type ?? "ClusterIP") === "LoadBalancer"
  ) {
    return;
  }

  try {
    await deleteBackend(cluster, namespace, serviceName);
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(
        `HTTPRoute deleted but Service cleanup failed: ${formatError(err)}`,
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
