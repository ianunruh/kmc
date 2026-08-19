import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Menu,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconDotsVertical,
  IconPlus,
  IconRocket,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/datavolumes._index";
import { StatusBadge } from "~/ui/status-badge";
import {
  BulkActionBar,
  ClampedText,
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
  isBulkActionResult,
  namespacedKey,
  parseNamespacedBulkTargets,
  runBulkAction,
} from "~/lib/bulk-action";
import { actionFailure } from "~/lib/errors";
import { dataVolumePath, dataVolumesListPath, formatAge, vmPath } from "~/lib/format";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import { deleteDataVolume, listDataVolumes } from "~/datavolumes/datavolumes.server";
import { useRefresh } from "~/lib/refresh";
import type { BulkActionResult, DataVolumeSummary } from "~/lib/types";
import { resourceKey, useRowSelection } from "~/lib/use-row-selection";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Data Volumes · kmc" }];
}

export const loader = tracedLoader(async ({ request }: Route.LoaderArgs) => {
  return listDataVolumes(clusterFromRequest(request));
});

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "bulk-delete") {
    const { targets, error } = parseNamespacedBulkTargets(form.get("targets"));
    if (error || !targets) {
      return {
        ok: false,
        error: error ?? "Missing targets",
        intent,
        summary: { total: 0, succeeded: 0, skipped: 0, failed: 0 },
        results: [],
      };
    }
    return runBulkAction(intent, targets, namespacedKey, async (t) => {
      await deleteDataVolume(t.cluster, t.namespace, t.name);
    });
  }

  const cluster = String(form.get("cluster") ?? "");
  const namespace = String(form.get("namespace") ?? "");
  const name = String(form.get("name") ?? "");

  if (intent !== "delete") {
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  }
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing identity", intent };
  }
  try {
    await deleteDataVolume(cluster, namespace, name);
    return { ok: true, intent };
  } catch (err) {
    return actionFailure("datavolume.delete", err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

type ActionResult =
  | { ok?: boolean; error?: string; intent?: string }
  | BulkActionResult;

export default function DataVolumesPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [deleteTarget, setDeleteTarget] = useState<DataVolumeSummary | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [ownership, setOwnership] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return items.filter((dv) => {
      if (filters.cluster && dv.cluster !== filters.cluster) return false;
      if (filters.namespace && dv.namespace !== filters.namespace) return false;
      if (filters.phase && dv.phase !== filters.phase) return false;
      if (ownership === "retained" && !dv.retainedFromVm) return false;
      if (ownership === "owned" && !dv.ownerName) return false;
      if (ownership === "unowned" && (dv.ownerName || dv.retainedFromVm)) return false;
      return matchesQuery(qDraft, [
        dv.name,
        dv.namespace,
        dv.cluster,
        dv.phase,
        dv.sourceKind,
        dv.sourceDetail,
        dv.ownerName,
        dv.retainedFromVm,
      ]);
    });
  }, [
    items,
    filters.cluster,
    filters.namespace,
    filters.phase,
    ownership,
    qDraft,
  ]);

  const visibleKeys = useMemo(() => filtered.map(resourceKey), [filtered]);
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
    () => filtered.filter((dv) => selected.has(resourceKey(dv))),
    [filtered, selected],
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
      notifyActionSuccess("Done", "DataVolume deleted");
      refreshNow();
    }
  });

  const namespaces = useMemo(() => {
    const set = new Set(items.map((dv) => dv.namespace));
    return Array.from(set).sort();
  }, [items]);

  const phases = useMemo(() => {
    const set = new Set(items.map((dv) => dv.phase));
    return Array.from(set).sort();
  }, [items]);

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Data Volumes"
        description={`${filtered.length} shown · ${items.length} total · golden images are under Images`}
        actions={
          <Button
            component={Link}
            to="/datavolumes/create"
            leftSection={<IconPlus size={16} />}
          >
            Create DataVolume
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
            placeholder="Phase"
            clearable
            data={phases}
            value={filters.phase}
            onChange={(v) => setFilter("phase", v)}
            w={180}
          />
          <Select
            placeholder="Ownership"
            clearable
            data={[
              { value: "retained", label: "Retained from VM" },
              { value: "owned", label: "Owned" },
              { value: "unowned", label: "Unowned" },
            ]}
            value={ownership}
            onChange={(v) => setOwnership(v)}
            w={180}
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
            emptyMessage="No data volumes found across configured clusters."
            headers={[
              <Checkbox
                key="select-all"
                aria-label="Select all visible"
                checked={allSelected}
                indeterminate={someSelected}
                disabled={busy || filtered.length === 0}
                onChange={() => toggleAllVisible()}
              />,
              "Name",
              "Cluster",
              "Namespace",
              "Phase",
              "Size",
              "Source",
              "Age",
              "",
            ]}
          >
            {filtered.map((dv) => {
              const key = resourceKey(dv);
              return (
                <Table.Tr key={key} bg={isSelected(key) ? "dark.7" : undefined}>
                  <Table.Td w={40}>
                    <Checkbox
                      aria-label={`Select ${dv.name}`}
                      checked={isSelected(key)}
                      disabled={busy}
                      onChange={() => toggle(key)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <ResourceLink to={dataVolumePath(dv)}>{dv.name}</ResourceLink>
                      {dv.retainedFromVm ? (
                        <Badge size="xs" variant="light" color="grape">
                          retained
                        </Badge>
                      ) : null}
                    </Group>
                    {dv.retainedFromVm && (
                      <Text size="xs" c="dimmed">
                        retained from VM {dv.retainedFromVm}
                      </Text>
                    )}
                    {dv.ownerName && (
                      <Text size="xs" c="dimmed">
                        owned by{" "}
                        {dv.ownerKind === "VirtualMachine" ? (
                          <ResourceLink
                            to={vmPath({
                              cluster: dv.cluster,
                              namespace: dv.namespace,
                              name: dv.ownerName,
                            })}
                            dimmed
                          >
                            {dv.ownerKind}/{dv.ownerName}
                          </ResourceLink>
                        ) : (
                          `${dv.ownerKind}/${dv.ownerName}`
                        )}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={dataVolumesListPath({ cluster: dv.cluster })}
                      dimmed
                    >
                      {dv.cluster}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={dataVolumesListPath({
                        cluster: dv.cluster,
                        namespace: dv.namespace,
                      })}
                      dimmed
                    >
                      {dv.namespace}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={dataVolumesListPath({
                        cluster: dv.cluster,
                        phase: dv.phase,
                      })}
                      underline="never"
                    >
                      <StatusBadge status={dv.phase} />
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{dv.size ?? "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <ClampedText
                      size="sm"
                      lineClamp={2}
                      tooltip={
                        dv.sourceDetail
                          ? `${dv.sourceKind} ${dv.sourceDetail}`
                          : dv.sourceKind
                      }
                    >
                      {dv.sourceKind}
                      {dv.sourceDetail ? (
                        <Text span size="xs" c="dimmed" ml={6}>
                          {dv.sourceDetail}
                        </Text>
                      ) : null}
                    </ClampedText>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={dv.age || "unknown"}>
                      <Text size="sm" c="dimmed">
                        {formatAge(dv.age)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Menu shadow="md" width={200} position="bottom-end">
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`Actions for ${dv.name}`}
                        >
                          <IconDotsVertical size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {!dv.ownerName && dv.phase === "Succeeded" ? (
                          <Menu.Item
                            leftSection={<IconRocket size={14} />}
                            component={Link}
                            to={`/vms/create?cluster=${encodeURIComponent(dv.cluster)}&namespace=${encodeURIComponent(dv.namespace)}&diskSource=existingDataVolume&existingDataVolume=${encodeURIComponent(dv.name)}`}
                          >
                            Launch VM with this disk
                          </Menu.Item>
                        ) : null}
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          disabled={busy}
                          onClick={() => setDeleteTarget(dv)}
                        >
                          Delete
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
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
        identity={
          deleteTarget
            ? `${deleteTarget.cluster}/${deleteTarget.namespace}/${deleteTarget.name}`
            : null
        }
        title="Delete data volume"
        confirmLabel="Delete DataVolume"
        warning="The backing PVC may also be removed."
        loading={busy}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          fetcher.submit(
            {
              intent: "delete",
              cluster: deleteTarget.cluster,
              namespace: deleteTarget.namespace,
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
        identities={selectedItems.map(resourceKey)}
        title={`Delete ${selectedItems.length} data volume${selectedItems.length === 1 ? "" : "s"}`}
        confirmLabel={`Delete ${selectedItems.length}`}
        warning="Backing PVCs may also be removed."
        loading={busy}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit(
            {
              intent: "bulk-delete",
              targets: bulkTargetsJson(
                selectedItems.map((dv) => ({
                  cluster: dv.cluster,
                  namespace: dv.namespace,
                  name: dv.name,
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
