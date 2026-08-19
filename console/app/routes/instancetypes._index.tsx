import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Menu,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconDotsVertical,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/instancetypes._index";
import {
  BulkActionBar,
  ConfirmBulkDeleteModal,
  ConfirmDeleteModal,
  ConsolePaper,
  FilterBar,
  PageHeader,
  ResourceLink,
  ResourceTable,
  Table,
} from "~/ui";
import {
  notifyActionError,
  notifyActionSuccess,
  notifyBulkResult,
} from "~/lib/action-feedback";
import {
  bulkTargetsJson,
  clusterScopedKey,
  isBulkActionResult,
  parseClusterBulkTargets,
  runBulkAction,
} from "~/lib/bulk-action";
import { actionFailure } from "~/lib/errors";
import {
  formatAge,
  instanceTypeEditPath,
  instanceTypePath,
  instanceTypesListPath,
} from "~/lib/format";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import {
  deleteClusterInstanceType,
  listClusterInstanceTypes,
} from "~/instancetypes/instancetypes.server";
import { instanceTypeClassLabel } from "~/instancetypes/options";
import { useRefresh } from "~/lib/refresh";
import type { BulkActionResult, ClusterInstanceTypeSummary } from "~/lib/types";
import { clusterResourceKey, useRowSelection } from "~/lib/use-row-selection";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Instance Types · kmc" }];
}

export const loader = tracedLoader(async ({ request }: Route.LoaderArgs) => {
  return listClusterInstanceTypes(clusterFromRequest(request));
});

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "bulk-delete") {
    const { targets, error } = parseClusterBulkTargets(form.get("targets"));
    if (error || !targets) {
      return {
        ok: false,
        error: error ?? "Missing targets",
        intent,
        summary: { total: 0, succeeded: 0, skipped: 0, failed: 0 },
        results: [],
      };
    }
    return runBulkAction(intent, targets, clusterScopedKey, async (t) => {
      await deleteClusterInstanceType(t.cluster, t.name);
    });
  }

  const cluster = String(form.get("cluster") ?? "");
  const name = String(form.get("name") ?? "");

  if (intent !== "delete") {
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  }
  if (!cluster || !name) {
    return { ok: false, error: "Missing identity", intent };
  }
  try {
    await deleteClusterInstanceType(cluster, name);
    return { ok: true, intent };
  } catch (err) {
    return actionFailure("instancetype.delete", err, {
      intent,
      cluster,
      name,
    });
  }
}

type ActionResult =
  | { ok?: boolean; error?: string; intent?: string }
  | BulkActionResult;

export default function InstanceTypesPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClusterInstanceTypeSummary | null>(
    null,
  );
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const classOptions = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      if (it.class) set.add(it.class);
    }
    return [...set]
      .sort((a, b) => instanceTypeClassLabel(a).localeCompare(instanceTypeClassLabel(b)))
      .map((c) => ({ value: c, label: instanceTypeClassLabel(c) }));
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (filters.cluster && it.cluster !== filters.cluster) return false;
      if (classFilter && it.class !== classFilter) return false;
      if (sourceFilter === "builtin" && !it.builtin) return false;
      if (sourceFilter === "custom" && it.builtin) return false;
      return matchesQuery(qDraft, [
        it.name,
        it.cluster,
        it.memory,
        String(it.cpu),
        it.class,
        it.size,
        it.vendor,
        instanceTypeClassLabel(it.class),
        it.builtin ? "builtin built-in" : "custom",
      ]);
    });
  }, [items, filters.cluster, classFilter, sourceFilter, qDraft]);

  // Only custom (non-builtin) types are bulk-deletable.
  const deletableFiltered = useMemo(
    () => filtered.filter((it) => !it.builtin),
    [filtered],
  );
  const visibleKeys = useMemo(
    () => deletableFiltered.map(clusterResourceKey),
    [deletableFiltered],
  );
  const {
    selected,
    selectedCount,
    allSelected,
    someSelected,
    isSelected,
    toggle,
    toggleAllVisible,
    clear,
  } = useRowSelection(visibleKeys);

  const selectedItems = useMemo(
    () => deletableFiltered.filter((it) => selected.has(clusterResourceKey(it))),
    [deletableFiltered, selected],
  );

  useFetcherResult(fetcher, (data) => {
    if (isBulkActionResult(data)) {
      if (data.error && data.results.length === 0) {
        notifyActionError("Bulk action failed", data.error, { intent: data.intent });
        return;
      }
      notifyBulkResult("deleted", data.summary, data.results);
      clear();
      setBulkDeleteOpen(false);
      refreshNow();
      return;
    }
    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
    } else if (data.ok) {
      notifyActionSuccess("Done", "Instance type deleted");
      refreshNow();
    }
  });

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);
  const builtinCount = items.filter((it) => it.builtin).length;

  return (
    <Stack gap="md">
      <PageHeader
        title="Instance Types"
        description={`${filtered.length} shown · ${items.length} total · ${builtinCount} built-in (common-instancetypes)`}
        actions={
          <Button
            component={Link}
            to="/instancetypes/create"
            leftSection={<IconPlus size={16} />}
          >
            Create Instance Type
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
            placeholder="Search name, class, size…"
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
          {classOptions.length > 0 && (
            <Select
              placeholder="Class"
              clearable
              searchable
              data={classOptions}
              value={classFilter}
              onChange={setClassFilter}
              w={200}
            />
          )}
          <Select
            placeholder="Source"
            clearable
            data={[
              { value: "builtin", label: "Built-in" },
              { value: "custom", label: "Custom" },
            ]}
            value={sourceFilter}
            onChange={setSourceFilter}
            w={140}
          />
        </FilterBar>

        <Stack gap="sm">
          <BulkActionBar
            selectedCount={selectedCount}
            onClear={clear}
            disabled={busy}
          >
            <Button
              size="xs"
              variant="light"
              color="red"
              leftSection={<IconTrash size={14} />}
              disabled={busy}
              onClick={() => setBulkDeleteOpen(true)}
            >
              Delete
            </Button>
          </BulkActionBar>

          <ResourceTable
            isEmpty={filtered.length === 0}
            emptyMessage="No cluster instance types found (homelab may have none)."
            headers={[
              <Checkbox
                key="select-all"
                aria-label="Select all visible custom types"
                checked={allSelected}
                indeterminate={someSelected}
                disabled={busy || deletableFiltered.length === 0}
                onChange={() => toggleAllVisible()}
              />,
              "Name",
              "Class",
              "Size",
              "CPU",
              "Memory",
              "Source",
              "Cluster",
              "Age",
              "",
            ]}
          >
            {filtered.map((it) => {
              const key = clusterResourceKey(it);
              const selectable = !it.builtin;
              return (
                <Table.Tr
                  key={key}
                  bg={selectable && isSelected(key) ? "dark.7" : undefined}
                >
                  <Table.Td w={40}>
                    {selectable ? (
                      <Checkbox
                        aria-label={`Select ${it.name}`}
                        checked={isSelected(key)}
                        disabled={busy}
                        onChange={() => toggle(key)}
                      />
                    ) : null}
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink to={instanceTypePath(it)}>{it.name}</ResourceLink>
                    {it.vendor && (
                      <Text size="xs" c="dimmed">
                        {it.vendor}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {it.class ? instanceTypeClassLabel(it.class) : "—"}
                    </Text>
                    {it.class && (
                      <Text size="xs" c="dimmed">
                        {it.class}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{it.size || "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{it.cpu ? `${it.cpu}c` : "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{it.memory || "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    {it.builtin ? (
                      <Badge variant="light" color="blue" size="sm">
                        Built-in
                      </Badge>
                    ) : (
                      <Badge variant="light" color="gray" size="sm">
                        Custom
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={instanceTypesListPath({ cluster: it.cluster })}
                      dimmed
                    >
                      {it.cluster}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={it.age || "unknown"}>
                      <Text size="sm" c="dimmed">
                        {formatAge(it.age)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    {it.builtin ? (
                      <Tooltip label="Built-in types are managed by the KubeVirt operator and cannot be edited">
                        <Text size="xs" c="dimmed">
                          —
                        </Text>
                      </Tooltip>
                    ) : (
                      <Menu shadow="md" width={150} position="bottom-end">
                        <Menu.Target>
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            aria-label={`Actions for ${it.name}`}
                          >
                            <IconDotsVertical size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item
                            leftSection={<IconPencil size={14} />}
                            component={Link}
                            to={instanceTypeEditPath(it)}
                          >
                            Edit
                          </Menu.Item>
                          <Menu.Item
                            color="red"
                            leftSection={<IconTrash size={14} />}
                            disabled={busy}
                            onClick={() => setDeleteTarget(it)}
                          >
                            Delete
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </ResourceTable>
        </Stack>
      </ConsolePaper>

      <ConfirmDeleteModal
        opened={deleteTarget != null}
        resourceName={deleteTarget?.name ?? null}
        identity={deleteTarget ? `${deleteTarget.cluster}/${deleteTarget.name}` : null}
        title="Delete instance type"
        confirmLabel="Delete Instance Type"
        warning="VMs already bound to this type keep their revision; new VMs cannot use it."
        loading={busy}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          fetcher.submit(
            {
              intent: "delete",
              cluster: deleteTarget.cluster,
              name: deleteTarget.name,
            },
            { method: "post" },
          );
          setDeleteTarget(null);
        }}
      />

      <ConfirmBulkDeleteModal
        opened={bulkDeleteOpen}
        count={selectedItems.length}
        identities={selectedItems.map(clusterResourceKey)}
        title={`Delete ${selectedItems.length} instance type${selectedItems.length === 1 ? "" : "s"}`}
        confirmLabel={`Delete ${selectedItems.length}`}
        warning="VMs already bound to these types keep their revision; new VMs cannot use them."
        loading={busy}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit(
            {
              intent: "bulk-delete",
              targets: bulkTargetsJson(
                selectedItems.map((it) => ({
                  cluster: it.cluster,
                  name: it.name,
                })),
              ),
            },
            { method: "post" },
          );
        }}
      />
    </Stack>
  );
}
