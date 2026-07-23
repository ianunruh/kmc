import { Alert, Select, Stack, Text } from "@mantine/core";
import { useMemo } from "react";
import type { Route } from "./+types/topology._index";
import { ConsolePaper, FilterBar, PageHeader } from "~/ui";
import { clusterFromRequest } from "~/lib/search-params";
import { useListFilters } from "~/lib/use-list-filters";
import { NetworkGraph } from "~/topology/network-graph";
import { listNetworkTopology } from "~/topology/topology.server";
import type {
  TopologyEdge,
  TopologyNetworkNode,
  TopologyVmNode,
} from "~/lib/types";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Network map · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return listNetworkTopology(clusterFromRequest(request));
}

export default function TopologyPage({ loaderData }: Route.ComponentProps) {
  const { topology, clusters } = loaderData;
  const { filters, setFilter } = useListFilters();

  const namespaces = useMemo(() => {
    const set = new Set<string>();
    for (const n of topology.networks) set.add(n.namespace);
    for (const v of topology.vms) set.add(v.namespace);
    return Array.from(set).sort();
  }, [topology.networks, topology.vms]);

  const filtered = useMemo(() => {
    const cluster = filters.cluster;
    const namespace = filters.namespace;

    const networks = topology.networks.filter((n) => {
      if (cluster && n.cluster !== cluster) return false;
      if (namespace && n.namespace !== namespace) return false;
      return true;
    });
    const vms = topology.vms.filter((v) => {
      if (cluster && v.cluster !== cluster) return false;
      if (namespace && v.namespace !== namespace) return false;
      return true;
    });

    const netIds = new Set(networks.map((n) => n.id));
    const vmIds = new Set(vms.map((v) => v.id));
    const edges = topology.edges.filter(
      (e) => netIds.has(e.networkId) && vmIds.has(e.vmId),
    );

    // Drop networks with no edges when a VM-only filter would leave orphans
    // that aren't connected in-scope? Keep all NADs in scope so empty VPCs
    // still appear.
    return { networks, vms, edges } satisfies {
      networks: TopologyNetworkNode[];
      vms: TopologyVmNode[];
      edges: TopologyEdge[];
    };
  }, [
    topology.networks,
    topology.vms,
    topology.edges,
    filters.cluster,
    filters.namespace,
  ]);

  const unreachable = clusters.filter((c) => !c.reachable);
  const scoped = Boolean(filters.cluster && filters.namespace);
  const edgeCount = filtered.edges.length;
  const description = scoped
    ? `${filtered.networks.length} network${filtered.networks.length === 1 ? "" : "s"} · ${filtered.vms.length} VM${filtered.vms.length === 1 ? "" : "s"} · ${edgeCount} link${edgeCount === 1 ? "" : "s"}`
    : "Select a cluster and namespace to focus the graph (or browse all reachable resources)";

  return (
    <Stack gap="md">
      <PageHeader title="Network map" description={description} />

      {unreachable.map((c) => (
        <Alert key={c.id} color="red" title={`${c.id}: unreachable`} variant="light">
          {c.error}
        </Alert>
      ))}

      <ConsolePaper>
        <FilterBar>
          <Select
            placeholder="Cluster"
            clearable
            data={clusters.map((c) => c.id)}
            value={filters.cluster}
            onChange={(v) => setFilter("cluster", v)}
            w={200}
          />
          <Select
            placeholder="Namespace"
            clearable
            searchable
            data={namespaces}
            value={filters.namespace}
            onChange={(v) => setFilter("namespace", v)}
            w={200}
          />
          {!filters.cluster && !filters.namespace && (
            <Text size="xs" c="dimmed" style={{ alignSelf: "center" }}>
              Showing all clusters and namespaces
            </Text>
          )}
        </FilterBar>

        <NetworkGraph
          networks={filtered.networks}
          vms={filtered.vms}
          edges={filtered.edges}
        />
      </ConsolePaper>
    </Stack>
  );
}
