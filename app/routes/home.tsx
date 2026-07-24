import { Alert, Button, Select, Stack, TextInput } from "@mantine/core";
import { IconPlus, IconSearch } from "@tabler/icons-react";
import { useMemo } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/home";
import { VmTable } from "~/vms/vm-table";
import { ConsolePaper, FilterBar, PageHeader } from "~/ui";
import { actionFailure, formatError } from "~/lib/errors";
import { clusterFromRequest } from "~/lib/search-params";
import type {
  BulkActionResult,
  BulkItemResult,
  BulkResourceTarget,
} from "~/lib/types";
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

/** Max targets accepted in one bulk POST. */
const BULK_TARGET_LIMIT = 100;

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Virtual Machines · kmc" },
    { name: "description", content: "kcloud management console" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  return listVms(clusterFromRequest(request));
}

function parseBulkTargets(raw: FormDataEntryValue | null): {
  targets?: BulkResourceTarget[];
  error?: string;
} {
  if (raw == null || String(raw).trim() === "") {
    return { error: "Missing targets" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { error: "Invalid targets JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { error: "Targets must be an array" };
  }
  if (parsed.length === 0) {
    return { error: "No targets selected" };
  }
  if (parsed.length > BULK_TARGET_LIMIT) {
    return {
      error: `Too many targets (max ${BULK_TARGET_LIMIT})`,
    };
  }
  const targets: BulkResourceTarget[] = [];
  for (const item of parsed) {
    if (item == null || typeof item !== "object") {
      return { error: "Each target must be an object" };
    }
    const cluster = String((item as BulkResourceTarget).cluster ?? "").trim();
    const namespace = String((item as BulkResourceTarget).namespace ?? "").trim();
    const name = String((item as BulkResourceTarget).name ?? "").trim();
    if (!cluster || !namespace || !name) {
      return { error: "Each target needs cluster, namespace, and name" };
    }
    targets.push({ cluster, namespace, name });
  }
  return { targets };
}

function summarizeResults(results: BulkItemResult[]): BulkActionResult["summary"] {
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "ok") succeeded += 1;
    else if (r.status === "skipped") skipped += 1;
    else failed += 1;
  }
  return { total: results.length, succeeded, skipped, failed };
}

async function runBulkVmAction(
  intent: "bulk-start" | "bulk-stop" | "bulk-delete",
  targets: BulkResourceTarget[],
  options?: { retainDisks?: boolean },
): Promise<BulkActionResult> {
  const results: BulkItemResult[] = [];

  for (const t of targets) {
    try {
      if (intent === "bulk-start") {
        await startVm(t.cluster, t.namespace, t.name);
        results.push({ ...t, status: "ok" });
      } else if (intent === "bulk-stop") {
        await stopVm(t.cluster, t.namespace, t.name);
        results.push({ ...t, status: "ok" });
      } else {
        const result = await deleteVm(t.cluster, t.namespace, t.name, {
          retainDisks: options?.retainDisks ?? false,
        });
        results.push({
          ...t,
          status: "ok",
          retainedDisks: result.retainedDisks,
        });
      }
    } catch (err) {
      results.push({
        ...t,
        status: "failed",
        error: formatError(err),
      });
    }
  }

  const summary = summarizeResults(results);
  return {
    ok: summary.failed === 0,
    intent,
    summary,
    results,
    retainDisks: options?.retainDisks,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (
    intent === "bulk-start" ||
    intent === "bulk-stop" ||
    intent === "bulk-delete"
  ) {
    const { targets, error } = parseBulkTargets(form.get("targets"));
    if (error || !targets) {
      return {
        ok: false,
        error: error ?? "Missing targets",
        intent,
      };
    }
    try {
      const retainDisks =
        intent === "bulk-delete" ? form.get("retainDisks") === "true" : undefined;
      return await runBulkVmAction(intent, targets, { retainDisks });
    } catch (err) {
      return actionFailure(`vm.${intent}`, err, { intent });
    }
  }

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
