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
  KMC_LABEL_RESOURCE,
  KMC_LABEL_VLAN,
  KMC_MANAGED_BY,
  KMC_RESOURCE_NETWORK,
  KMC_RESOURCE_VPC,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import type {
  ClusterId,
  NetworkTopology,
  TopologyEdge,
  TopologyNetworkNode,
  TopologyVmNode,
} from "~/lib/types";
import { listFloatingIpsFromPolicies } from "~/vpcs/nat-policy.server";
import { listClusters } from "~/vms/vms.server";

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
    annotations?: Record<string, string>;
  };
  status?: {
    printableStatus?: string;
    ready?: boolean;
    conditions?: Array<{ type?: string; status?: string }>;
  };
  spec?: {
    template?: {
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

function nodeId(cluster: string, namespace: string, name: string): string {
  return `${cluster}/${namespace}/${name}`;
}

function podNodeId(cluster: string, namespace: string): string {
  return nodeId(cluster, namespace, "__pod__");
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
    const floats = await listFloatingIpsFromPolicies(cluster);
    const pools = listIpPools(cluster);
    for (const f of floats) {
      const publicAddr =
        addressFromIpv4Annotation(f.public) ?? f.public.trim();
      if (!publicAddr) continue;

      let targetVmId: string | undefined;
      if (f.targetVm?.trim()) {
        targetVmId = vmByNsName.get(`${f.namespace}/${f.targetVm.trim()}`)?.id;
      }
      if (!targetVmId) {
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

  const networks = Array.from(networksById.values()).sort((a, b) => {
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    if (a.kind === "pod" && b.kind !== "pod") return -1;
    if (a.kind !== "pod" && b.kind === "pod") return 1;
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

  networks.sort((a, b) => {
    const c = a.cluster.localeCompare(b.cluster);
    if (c) return c;
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    if (a.kind === "pod" && b.kind !== "pod") return -1;
    if (a.kind !== "pod" && b.kind === "pod") return 1;
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
