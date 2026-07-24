import { Alert, Button, Select, Stack, TextInput } from "@mantine/core";
import { IconPlus, IconSearch } from "@tabler/icons-react";
import { useMemo } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/home";
import { VmTable } from "~/vms/vm-table";
import { ConsolePaper, FilterBar, PageHeader } from "~/ui";
import { actionFailure } from "~/lib/errors";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import {
  deleteVm,
  listVms,
  pauseVm,
  restartVm,
  softRebootVm,
  startVm,
  stopVm,
  unpauseVm,
} from "~/vms/vms.server";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Virtual Machines · kmc" },
    { name: "description", content: "kcloud management console" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  return listVms(clusterFromRequest(request));
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
    } else if (intent === "restart") {
      await restartVm(cluster, namespace, name);
    } else if (intent === "softreboot") {
      await softRebootVm(cluster, namespace, name);
    } else if (intent === "pause") {
      await pauseVm(cluster, namespace, name);
    } else if (intent === "unpause") {
      await unpauseVm(cluster, namespace, name);
    } else if (intent === "delete") {
      const retainDisks = form.get("retainDisks") === "true";
      const result = await deleteVm(cluster, namespace, name, { retainDisks });
      return {
        ok: true,
        intent,
        retainDisks,
        retainedDisks: result.retainedDisks,
      };
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
  const { filters, qDraft, setQ, setFilter } = useListFilters();

  const namespaces = useMemo(() => {
    const set = new Set(items.map((v) => v.namespace));
    return Array.from(set).sort();
  }, [items]);

  const statuses = useMemo(() => {
    const set = new Set(items.map((v) => v.status));
    return Array.from(set).sort();
  }, [items]);

  const instanceTypes = useMemo(() => {
    const set = new Set(
      items.map((v) => v.instanceType).filter((v): v is string => Boolean(v)),
    );
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((vm) => {
      if (filters.cluster && vm.cluster !== filters.cluster) return false;
      if (filters.namespace && vm.namespace !== filters.namespace) return false;
      if (filters.status && vm.status !== filters.status) return false;
      if (filters.instancetype && vm.instanceType !== filters.instancetype) {
        return false;
      }
      return matchesQuery(qDraft, [
        vm.name,
        vm.namespace,
        vm.cluster,
        vm.status,
        vm.nodeName,
        vm.cpu,
        vm.memory,
        vm.disk,
        vm.instanceType,
      ]);
    });
  }, [
    items,
    filters.cluster,
    filters.namespace,
    filters.status,
    filters.instancetype,
    qDraft,
  ]);

  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Virtual Machines"
        description={`${filtered.length} shown · ${items.length} total across ${clusters.filter((c) => c.reachable).length} cluster${clusters.filter((c) => c.reachable).length === 1 ? "" : "s"}`}
        actions={
          <Button component={Link} to="/vms/create" leftSection={<IconPlus size={16} />}>
            Launch VM
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
            value={qDraft}
            onChange={(e) => setQ(e.currentTarget.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <Select
            placeholder="Cluster"
            clearable
            data={clusters.map((c) => c.id)}
            value={filters.cluster}
            onChange={(v) => setFilter("cluster", v)}
            w={180}
          />
          <Select
            placeholder="Namespace"
            clearable
            searchable
            data={namespaces}
            value={filters.namespace}
            onChange={(v) => setFilter("namespace", v)}
            w={180}
          />
          <Select
            placeholder="Status"
            clearable
            data={statuses}
            value={filters.status}
            onChange={(v) => setFilter("status", v)}
            w={160}
          />
          {instanceTypes.length > 0 && (
            <Select
              placeholder="Instance type"
              clearable
              searchable
              data={instanceTypes}
              value={filters.instancetype}
              onChange={(v) => setFilter("instancetype", v)}
              w={200}
            />
          )}
        </FilterBar>

        <VmTable vms={filtered} />
      </ConsolePaper>
    </Stack>
  );
}
