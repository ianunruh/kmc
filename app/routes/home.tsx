import { Alert, Button, Select, Stack, TextInput } from "@mantine/core";
import { IconPlus, IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/home";
import { VmTable } from "~/vms/vm-table";
import { ConsolePaper, FilterBar, PageHeader } from "~/ui";
import { actionFailure } from "~/lib/errors";
import { deleteVm, listVms, startVm, stopVm } from "~/vms/vms.server";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Virtual Machines · kmc" },
    { name: "description", content: "Multi-cluster KubeVirt console" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const cluster = url.searchParams.get("cluster") ?? undefined;
  return listVms(cluster || undefined);
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const cluster = String(form.get("cluster") ?? "");
  const namespace = String(form.get("namespace") ?? "");
  const name = String(form.get("name") ?? "");

  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing cluster, namespace, or name", intent };
  }

  try {
    if (intent === "stop") {
      await stopVm(cluster, namespace, name);
    } else if (intent === "start") {
      await startVm(cluster, namespace, name);
    } else if (intent === "delete") {
      await deleteVm(cluster, namespace, name);
    } else {
      return { ok: false, error: `Unknown intent: ${intent}`, intent };
    }
    return { ok: true, intent };
  } catch (err) {
    return actionFailure(`vm.${intent}`, err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const [search, setSearch] = useState("");
  const [clusterFilter, setClusterFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const statuses = useMemo(() => {
    const set = new Set(items.map((v) => v.status));
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((vm) => {
      if (clusterFilter && vm.cluster !== clusterFilter) return false;
      if (statusFilter && vm.status !== statusFilter) return false;
      if (!q) return true;
      return (
        vm.name.toLowerCase().includes(q) ||
        vm.namespace.toLowerCase().includes(q) ||
        vm.cluster.toLowerCase().includes(q)
      );
    });
  }, [items, search, clusterFilter, statusFilter]);

  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Virtual Machines"
        description={`${filtered.length} shown · ${items.length} total across ${clusters.filter((c) => c.reachable).length} cluster${clusters.filter((c) => c.reachable).length === 1 ? "" : "s"}`}
        actions={
          <Button component={Link} to="/vms/create" leftSection={<IconPlus size={16} />}>
            Create VM
          </Button>
        }
      />

      {unreachable.map((c) => (
        <Alert key={c.id} color="red" title={`${c.id}: unreachable`} variant="light">
          {c.error}
        </Alert>
      ))}

      <ConsolePaper>
        <FilterBar>
          <TextInput
            placeholder="Search name, namespace, cluster…"
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <Select
            placeholder="Cluster"
            clearable
            data={clusters.map((c) => c.id)}
            value={clusterFilter}
            onChange={setClusterFilter}
            w={180}
          />
          <Select
            placeholder="Status"
            clearable
            data={statuses}
            value={statusFilter}
            onChange={setStatusFilter}
            w={180}
          />
        </FilterBar>

        <VmTable vms={filtered} />
      </ConsolePaper>
    </Stack>
  );
}
