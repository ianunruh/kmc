import { formatError } from "~/lib/errors";
import {
  addressFromIpv4Annotation,
  containsIpv4,
  parseCidr,
} from "~/lib/ipam/cidr";
import { IPAM_ANNOTATION_IPV4 } from "~/lib/ipam/constants";
import {
  listIpPools,
  parseIpv4AnnotationList,
} from "~/lib/ipam/pools.server";
import {
  KMC_ANN_CIDR,
  KMC_ANN_MEMBER_VMS,
  KMC_BACKEND_LABEL_SELECTOR,
  GATEWAY_API_GROUP,
  GATEWAY_API_VERSION,
  HTTP_ROUTE_PLURAL,
  KMC_HTTP_ROUTE_LABEL_SELECTOR,
  KMC_LABEL_BACKEND_GROUP,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_VM,
  KMC_LABEL_VLAN,
  KMC_MANAGED_BY,
  KMC_RESOURCE_NETWORK,
  KMC_RESOURCE_VPC,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import {
  labelsMatchSelector,
  membershipFromServiceMeta,
} from "~/backends/membership";
import type {
  ClusterId,
  NetworkTopology,
  TopologyEdge,
  TopologyNetworkNode,
  TopologyVmNode,
} from "~/lib/types";
import { listFloatingIps, listPortForwards } from "~/vpcs/vpcs.server";

import { listClusters } from "~/vms/vms.server";

type KubeHttpRoute = {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    hostnames?: string[];
    rules?: Array<{
      backendRefs?: Array<{ name?: string }>;
    }>;
  };
};

type KubeNad = {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
};

type KubeVm = {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  status?: {
    printableStatus?: string;
    ready?: boolean;
    conditions?: Array<{ type?: string; status?: string }>;
  };
  spec?: {
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: {
        networks?: Array<{
          name?: string;
          pod?: unknown;
          multus?: { networkName?: string };
        }>;
      };
    };
  };
};

type KubeBackendService = {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    type?: string;
    selector?: Record<string, string>;
  };
  status?: {
    loadBalancer?: {
      ingress?: Array<{ ip?: string; hostname?: string }>;
    };
  };
};

function nodeId(cluster: string, namespace: string, name: string): string {
  return `${cluster}/${namespace}/${name}`;
}

function podNodeId(cluster: string, namespace: string): string {
  return nodeId(cluster, namespace, "__pod__");
}

function httpRouteNodeId(cluster: string, namespace: string): string {
  return nodeId(cluster, namespace, "__httproute__");
}

function loadBalancerNodeId(cluster: string, namespace: string): string {
  return nodeId(cluster, namespace, "__loadbalancer__");
}

function externalAddress(svc: KubeBackendService): string | undefined {
  const lb = svc.status?.loadBalancer?.ingress?.[0];
  if (!lb) return undefined;
  return lb.hostname || lb.ip || undefined;
}

/**
 * Resolve VM names selected by a kmc backend Service (single-vm, group, labels).
 * `vmLabelsByKey` is namespace/name → pod-template-ish labels for label selectors.
 */
function targetVmsFromBackend(
  svc: KubeBackendService,
  vmLabelsByKey: Map<string, Record<string, string>>,
  namespace: string,
): string[] {
  const names = new Set<string>();
  const membership = membershipFromServiceMeta(
    svc.metadata?.labels,
    svc.metadata?.annotations,
  );

  if (membership.mode === "single-vm") {
    names.add(membership.vmName);
  } else if (membership.mode === "group") {
    for (const n of membership.vmNames) names.add(n);
    // Live stamp may include VMs not in the create-time annotation
    const groupId = membership.groupId;
    if (groupId) {
      for (const [key, labels] of vmLabelsByKey) {
        if (!key.startsWith(`${namespace}/`)) continue;
        if (labels[KMC_LABEL_BACKEND_GROUP] === groupId) {
          names.add(key.slice(namespace.length + 1));
        }
      }
    }
  } else if (membership.mode === "labels") {
    for (const [key, labels] of vmLabelsByKey) {
      if (!key.startsWith(`${namespace}/`)) continue;
      if (labelsMatchSelector(labels, membership.matchLabels)) {
        names.add(key.slice(namespace.length + 1));
      }
    }
  } else {
    // Fallback: annotation + classic selector
    const members = (svc.metadata?.annotations?.[KMC_ANN_MEMBER_VMS] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const m of members) names.add(m);
    const labeled = svc.metadata?.labels?.[KMC_LABEL_VM]?.trim();
    if (labeled) names.add(labeled);
    const selVm = svc.spec?.selector?.["kubevirt.io/vm"]?.trim();
    if (selVm) names.add(selVm);
  }

  return Array.from(names).sort();
}

/**
 * kmc VPC NADs use resource=vpc. Static Multus NADs (e.g. external) use
 * resource=network and may still carry a VLAN label — do not treat those as VPCs.
 * Legacy fallback: managed-by=kmc + vlan, excluding explicit network resources.
 */
function isVpcNad(labels: Record<string, string>): boolean {
  const resource = labels[KMC_LABEL_RESOURCE];
  if (resource === KMC_RESOURCE_VPC) return true;
  if (resource === KMC_RESOURCE_NETWORK) return false;
  return (
    labels[MANAGED_BY_LABEL] === KMC_MANAGED_BY && labels[KMC_LABEL_VLAN] != null
  );
}

function mapNad(
  cluster: ClusterId,
  nad: KubeNad,
): TopologyNetworkNode | null {
  const name = nad.metadata?.name;
  const namespace = nad.metadata?.namespace;
  if (!name || !namespace) return null;
  const labels = nad.metadata?.labels ?? {};
  const ann = nad.metadata?.annotations ?? {};
  const vlanRaw = labels[KMC_LABEL_VLAN];
  const vlanNum = vlanRaw ? Number(vlanRaw) : undefined;
  const vlan =
    vlanNum != null && Number.isInteger(vlanNum) && vlanNum > 0
      ? vlanNum
      : undefined;
  return {
    id: nodeId(cluster, namespace, name),
    kind: isVpcNad(labels) ? "vpc" : "multus",
    cluster,
    namespace,
    name,
    vlan,
    cidr: ann[KMC_ANN_CIDR],
    exists: true,
  };
}

/**
 * Resolve Multus networkName (bare or ns/name) to a topology network id
 * relative to the VM's namespace.
 */
function resolveMultusRef(
  cluster: ClusterId,
  vmNamespace: string,
  networkName: string,
): { networkId: string; namespace: string; name: string } | null {
  const ref = networkName.trim();
  if (!ref) return null;
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const ns = ref.slice(0, slash);
    const name = ref.slice(slash + 1);
    if (!ns || !name) return null;
    return {
      networkId: nodeId(cluster, ns, name),
      namespace: ns,
      name,
    };
  }
  return {
    networkId: nodeId(cluster, vmNamespace, ref),
    namespace: vmNamespace,
    name: ref,
  };
}

function mapVmStatus(vm: KubeVm): { status: string; ready: boolean } {
  const status = vm.status?.printableStatus ?? "Unknown";
  const readyCondition = vm.status?.conditions?.find((c) => c.type === "Ready");
  const ready =
    vm.status?.ready === true ||
    readyCondition?.status === "True" ||
    status === "Running";
  return { status, ready };
}

async function loadClusterTopology(
  cluster: ClusterId,
): Promise<NetworkTopology> {
  const { custom } = getClusterClients(cluster);
  const networksById = new Map<string, TopologyNetworkNode>();
  const vms: TopologyVmNode[] = [];
  const edges: TopologyEdge[] = [];

  const [nadRes, vmRes] = await Promise.all([
    custom.listClusterCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      plural: "network-attachment-definitions",
    }) as Promise<{ items?: KubeNad[] }>,
    custom.listClusterCustomObject({
      group: "kubevirt.io",
      version: "v1",
      plural: "virtualmachines",
    }) as Promise<{ items?: KubeVm[] }>,
  ]);

  for (const nad of nadRes.items ?? []) {
    const node = mapNad(cluster, nad);
    if (node) networksById.set(node.id, node);
  }

  // Index VMs for floating-IP attachment (by name and private IPAM addresses).
  const vmByNsName = new Map<string, TopologyVmNode>();
  const vmIdsByPrivate = new Map<string, string>(); // ns|addr -> vmId
  /** namespace/name → labels for Service selector matching (LB / multi-member). */
  const vmLabelsByKey = new Map<string, Record<string, string>>();

  for (const vm of vmRes.items ?? []) {
    const name = vm.metadata?.name;
    const namespace = vm.metadata?.namespace;
    if (!name || !namespace) continue;

    const vmId = nodeId(cluster, namespace, name);
    const { status, ready } = mapVmStatus(vm);
    const node: TopologyVmNode = {
      id: vmId,
      cluster,
      namespace,
      name,
      status,
      ready,
    };
    vms.push(node);
    vmByNsName.set(`${namespace}/${name}`, node);
    vmLabelsByKey.set(`${namespace}/${name}`, {
      ...(vm.metadata?.labels ?? {}),
      ...(vm.spec?.template?.metadata?.labels ?? {}),
      "kubevirt.io/vm": name,
    });

    const ann = vm.metadata?.annotations?.[IPAM_ANNOTATION_IPV4];
    if (ann) {
      for (const addr of parseIpv4AnnotationList(ann)) {
        vmIdsByPrivate.set(`${namespace}|${addr}`, vmId);
      }
    }

    const networks = vm.spec?.template?.spec?.networks ?? [];
    for (const net of networks) {
      const interfaceName = net.name;

      if (net.pod != null) {
        const pid = podNodeId(cluster, namespace);
        if (!networksById.has(pid)) {
          networksById.set(pid, {
            id: pid,
            kind: "pod",
            cluster,
            namespace,
            name: "pod network",
            exists: true,
          });
        }
        edges.push({
          id: `${pid}->${vmId}:${interfaceName ?? "pod"}`,
          networkId: pid,
          vmId,
          interfaceName,
          role: "attachment",
        });
        continue;
      }

      const multusName = net.multus?.networkName;
      if (!multusName) continue;
      const resolved = resolveMultusRef(cluster, namespace, multusName);
      if (!resolved) continue;

      if (!networksById.has(resolved.networkId)) {
        // Orphan Multus ref (NAD missing / other namespace not listed).
        networksById.set(resolved.networkId, {
          id: resolved.networkId,
          kind: "multus",
          cluster,
          namespace: resolved.namespace,
          name: resolved.name,
          exists: false,
        });
      }

      edges.push({
        id: `${resolved.networkId}->${vmId}:${interfaceName ?? multusName}`,
        networkId: resolved.networkId,
        vmId,
        interfaceName,
        role: "attachment",
      });
    }
  }

  // Floating IPs: stamp target VMs + edges from the public Multus pool → target.
  try {
    const floats = (await listFloatingIps(cluster)).items;
    const pools = await listIpPools(cluster);
    for (const f of floats) {
      if (f.state !== "associated") continue;
      const publicAddr =
        addressFromIpv4Annotation(f.public) ?? f.public.trim();
      if (!publicAddr) continue;

      let targetVmId: string | undefined;
      if (f.targetVm?.trim()) {
        targetVmId = vmByNsName.get(`${f.namespace}/${f.targetVm.trim()}`)?.id;
      }
      if (!targetVmId && f.private?.trim()) {
        const priv = addressFromIpv4Annotation(f.private) ?? f.private.trim();
        if (priv) {
          targetVmId = vmIdsByPrivate.get(`${f.namespace}|${priv}`);
        }
      }
      if (!targetVmId) continue;

      const target = vms.find((v) => v.id === targetVmId);
      if (target) {
        const list = target.floatingIpv4 ?? [];
        if (!list.includes(publicAddr)) {
          target.floatingIpv4 = [...list, publicAddr];
        }
      }

      // Public Multus network whose pool contains this float (e.g. external).
      let publicRef: ReturnType<typeof resolveMultusRef> = null;
      for (const pool of pools) {
        try {
          if (containsIpv4(parseCidr(pool.cidr), publicAddr)) {
            publicRef = resolveMultusRef(
              cluster,
              f.namespace,
              pool.multusNetwork,
            );
            break;
          }
        } catch {
          /* skip bad pool */
        }
      }
      if (!publicRef) continue;

      if (!networksById.has(publicRef.networkId)) {
        networksById.set(publicRef.networkId, {
          id: publicRef.networkId,
          kind: "multus",
          cluster,
          namespace: publicRef.namespace,
          name: publicRef.name,
          exists: false,
        });
      }

      edges.push({
        id: `fip:${publicRef.networkId}->${targetVmId}:${publicAddr}`,
        networkId: publicRef.networkId,
        vmId: targetVmId,
        role: "floating",
        label: publicAddr,
      });
    }
  } catch (err) {
    console.error(
      `topology floating IPs (${cluster}):`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Port forwards: public Multus → target (dashed, distinct from full FIP).
  try {
    const pfs = (await listPortForwards(cluster)).items;
    const pools = await listIpPools(cluster);
    for (const pf of pfs) {
      const publicAddr =
        addressFromIpv4Annotation(pf.public) ?? pf.public.trim();
      if (!publicAddr) continue;

      let targetVmId: string | undefined;
      if (pf.targetVm?.trim()) {
        targetVmId = vmByNsName.get(`${pf.namespace}/${pf.targetVm.trim()}`)?.id;
      }
      if (!targetVmId && pf.private?.trim()) {
        const priv = addressFromIpv4Annotation(pf.private) ?? pf.private.trim();
        if (priv) {
          targetVmId = vmIdsByPrivate.get(`${pf.namespace}|${priv}`);
        }
      }
      if (!targetVmId) continue;

      let publicRef: ReturnType<typeof resolveMultusRef> = null;
      for (const pool of pools) {
        try {
          if (containsIpv4(parseCidr(pool.cidr), publicAddr)) {
            publicRef = resolveMultusRef(
              cluster,
              pf.namespace,
              pool.multusNetwork,
            );
            break;
          }
        } catch {
          /* skip bad pool */
        }
      }
      if (!publicRef) continue;

      if (!networksById.has(publicRef.networkId)) {
        networksById.set(publicRef.networkId, {
          id: publicRef.networkId,
          kind: "multus",
          cluster,
          namespace: publicRef.namespace,
          name: publicRef.name,
          exists: false,
        });
      }

      const label = `${publicAddr}:${pf.publicPort}`;
      edges.push({
        id: `pf:${publicRef.networkId}->${targetVmId}:${label}/${pf.protocol}`,
        networkId: publicRef.networkId,
        vmId: targetVmId,
        role: "portforward",
        label,
      });
    }
  } catch (err) {
    console.error(
      `topology port forwards (${cluster}):`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // kmc backend Services (HTTPRoute companions + LoadBalancers)
  let backendServices: KubeBackendService[] = [];
  try {
    const { core } = getClusterClients(cluster);
    const svcRes = await core.listServiceForAllNamespaces({
      labelSelector: KMC_BACKEND_LABEL_SELECTOR,
    });
    backendServices = (svcRes.items ?? []) as KubeBackendService[];
  } catch (err) {
    console.error(
      `topology backends (${cluster}):`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const backendByKey = new Map<string, KubeBackendService>();
  for (const svc of backendServices) {
    const sn = svc.metadata?.name;
    const sns = svc.metadata?.namespace;
    if (!sn || !sns) continue;
    backendByKey.set(`${sns}/${sn}`, svc);
  }

  // HTTPRoutes: one synthetic "httproute" node per namespace + edges to target VMs.
  try {
    const { custom } = getClusterClients(cluster);
    const routeRes = (await custom.listClusterCustomObject({
      group: GATEWAY_API_GROUP,
      version: GATEWAY_API_VERSION,
      plural: HTTP_ROUTE_PLURAL,
      labelSelector: KMC_HTTP_ROUTE_LABEL_SELECTOR,
    })) as { items?: KubeHttpRoute[] };

    for (const route of routeRes.items ?? []) {
      const name = route.metadata?.name;
      const namespace = route.metadata?.namespace;
      if (!name || !namespace) continue;

      const hostList = (route.spec?.hostnames ?? []).filter((h): h is string =>
        Boolean(h),
      );
      const edgeLabel = hostList[0] ?? name;

      const targetVmNames = new Set<string>();
      const labeledVm = route.metadata?.labels?.[KMC_LABEL_VM]?.trim();
      if (labeledVm) targetVmNames.add(labeledVm);

      const backendName =
        route.spec?.rules?.[0]?.backendRefs?.[0]?.name ?? name;
      const backend = backendByKey.get(`${namespace}/${backendName}`);
      if (backend) {
        for (const m of targetVmsFromBackend(
          backend,
          vmLabelsByKey,
          namespace,
        )) {
          targetVmNames.add(m);
        }
      }

      if (targetVmNames.size === 0) continue;

      const rid = httpRouteNodeId(cluster, namespace);
      if (!networksById.has(rid)) {
        networksById.set(rid, {
          id: rid,
          kind: "httproute",
          cluster,
          namespace,
          name: "http routes",
          exists: true,
        });
      }

      for (const vmName of targetVmNames) {
        const target = vmByNsName.get(`${namespace}/${vmName}`);
        if (!target) continue;

        if (hostList.length > 0) {
          const existing = target.httpRouteHosts ?? [];
          const merged = [...existing];
          for (const h of hostList) {
            if (!merged.includes(h)) merged.push(h);
          }
          target.httpRouteHosts = merged;
        }

        edges.push({
          id: `httproute:${rid}->${target.id}:${name}`,
          networkId: rid,
          vmId: target.id,
          role: "httproute",
          label: edgeLabel,
        });
      }
    }
  } catch (err) {
    console.error(
      `topology http routes (${cluster}):`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Load balancers: synthetic node per namespace (right column, under HTTP routes).
  try {
    for (const svc of backendServices) {
      if ((svc.spec?.type ?? "ClusterIP") !== "LoadBalancer") continue;
      const name = svc.metadata?.name;
      const namespace = svc.metadata?.namespace;
      if (!name || !namespace) continue;

      const targetVmNames = targetVmsFromBackend(
        svc,
        vmLabelsByKey,
        namespace,
      );
      if (targetVmNames.length === 0) continue;

      const vip = externalAddress(svc);
      const edgeLabel = vip ?? name;

      const lid = loadBalancerNodeId(cluster, namespace);
      if (!networksById.has(lid)) {
        networksById.set(lid, {
          id: lid,
          kind: "loadbalancer",
          cluster,
          namespace,
          name: "load balancers",
          exists: true,
        });
      }

      for (const vmName of targetVmNames) {
        const target = vmByNsName.get(`${namespace}/${vmName}`);
        if (!target) continue;

        const addr = vip ?? name;
        const existing = target.loadBalancerAddresses ?? [];
        if (!existing.includes(addr)) {
          target.loadBalancerAddresses = [...existing, addr];
        }

        edges.push({
          id: `lb:${lid}->${target.id}:${name}`,
          networkId: lid,
          vmId: target.id,
          role: "loadbalancer",
          label: edgeLabel,
        });
      }
    }
  } catch (err) {
    console.error(
      `topology load balancers (${cluster}):`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const kindOrder = (k: TopologyNetworkNode["kind"]) => {
    if (k === "pod") return 0;
    if (k === "httproute") return 1;
    if (k === "loadbalancer") return 2;
    return 3;
  };

  const networks = Array.from(networksById.values()).sort((a, b) => {
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    const ko = kindOrder(a.kind) - kindOrder(b.kind);
    if (ko) return ko;
    return a.name.localeCompare(b.name);
  });

  vms.sort((a, b) => {
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    return a.name.localeCompare(b.name);
  });

  return { networks, vms, edges };
}

/**
 * Build a bipartite network topology (Multus/VPC/pod ↔ VMs) across clusters.
 * Optional `clusterFilter` limits to a single context.
 */
export async function listNetworkTopology(clusterFilter?: ClusterId): Promise<{
  topology: NetworkTopology;
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const contexts = clusterFilter ? [clusterFilter] : getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));

  const networks: TopologyNetworkNode[] = [];
  const vms: TopologyVmNode[] = [];
  const edges: TopologyEdge[] = [];

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const topo = await loadClusterTopology(id);
        networks.push(...topo.networks);
        vms.push(...topo.vms);
        edges.push(...topo.edges);
      } catch (err) {
        if (cluster) {
          cluster.reachable = false;
          cluster.error = formatError(err);
        }
      }
    }),
  );

  const kindOrder = (k: TopologyNetworkNode["kind"]) => {
    if (k === "pod") return 0;
    if (k === "httproute") return 1;
    if (k === "loadbalancer") return 2;
    return 3;
  };

  networks.sort((a, b) => {
    const c = a.cluster.localeCompare(b.cluster);
    if (c) return c;
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    const ko = kindOrder(a.kind) - kindOrder(b.kind);
    if (ko) return ko;
    return a.name.localeCompare(b.name);
  });

  vms.sort((a, b) => {
    const c = a.cluster.localeCompare(b.cluster);
    if (c) return c;
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    return a.name.localeCompare(b.name);
  });

  return {
    topology: { networks, vms, edges },
    clusters,
  };
}
