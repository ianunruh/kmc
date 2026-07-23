import { formatError } from "~/lib/errors";
import {
  KMC_ANN_CIDR,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_VLAN,
  KMC_MANAGED_BY,
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

function isVpcNad(labels: Record<string, string>): boolean {
  return (
    labels[KMC_LABEL_RESOURCE] === KMC_RESOURCE_VPC ||
    (labels[MANAGED_BY_LABEL] === KMC_MANAGED_BY && labels[KMC_LABEL_VLAN] != null)
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

  for (const vm of vmRes.items ?? []) {
    const name = vm.metadata?.name;
    const namespace = vm.metadata?.namespace;
    if (!name || !namespace) continue;

    const vmId = nodeId(cluster, namespace, name);
    const { status, ready } = mapVmStatus(vm);
    vms.push({
      id: vmId,
      cluster,
      namespace,
      name,
      status,
      ready,
    });

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
      });
    }
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
