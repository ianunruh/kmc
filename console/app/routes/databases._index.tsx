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
  IconSearch,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/databases._index";
import { StatusBadge } from "~/ui/status-badge";
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
  isBulkActionResult,
  namespacedKey,
  parseNamespacedBulkTargets,
  runBulkAction,
} from "~/lib/bulk-action";
import { actionFailure } from "~/lib/errors";
import {
  canOpenDatabaseTerminal,
  databaseCreatePath,
  databasePath,
  databasesListPath,
  databaseTerminalPath,
  formatAge,
} from "~/lib/format";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import { deleteDatabase, listDatabases } from "~/databases/databases.server";
import { useRefresh } from "~/lib/refresh";
import type { BulkActionResult, DatabaseSummary } from "~/lib/types";
import { resourceKey, useRowSelection } from "~/lib/use-row-selection";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Databases · kmc" }];
}

export const loader = tracedLoader(async ({ request }: Route.LoaderArgs) => {
  return listDatabases(clusterFromRequest(request));
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
      await deleteDatabase(t.cluster, t.namespace, t.name);
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
    await deleteDatabase(cluster, namespace, name);
    return { ok: true, intent };
  } catch (err) {
    return actionFailure("database.delete", err, {
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

export default function DatabasesPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [deleteTarget, setDeleteTarget] = useState<DatabaseSummary | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const namespaces = useMemo(() => {
    const set = new Set(items.map((db) => db.namespace));
    return Array.from(set).sort();
  }, [items]);

  const statuses = useMemo(() => {
    const set = new Set(items.map((db) => db.status));
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((db) => {
      if (filters.cluster && db.cluster !== filters.cluster) return false;
      if (filters.namespace && db.namespace !== filters.namespace) return false;
      if (filters.status && db.status !== filters.status) return false;
      return matchesQuery(qDraft, [
        db.name,
        db.namespace,
        db.cluster,
        db.status,
        db.phase,
        db.postgresVersion,
        db.imageName,
        db.storageSize,
        db.currentPrimary,
        db.managedByKmc ? "kmc managed" : undefined,
      ]);
    });
  }, [items, filters.cluster, filters.namespace, filters.status, qDraft]);

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
    () => filtered.filter((db) => selected.has(resourceKey(db))),
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
      notifyActionSuccess("Done", "Database cluster deleted");
      refreshNow();
    }
  });

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Databases"
        description={`${filtered.length} shown · ${items.length} total · PostgreSQL via CloudNativePG`}
        actions={
          <Button
            component={Link}
            to={databaseCreatePath()}
            leftSection={<IconPlus size={16} />}
          >
            Create database
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
            placeholder="Search name, namespace, version…"
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
            emptyMessage="No CloudNativePG clusters found. Create one to get started."
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
              "Status",
              "Instances",
              "Postgres",
              "Storage",
              "Age",
              "",
            ]}
          >
            {filtered.map((db) => {
              const key = resourceKey(db);
              return (
                <Table.Tr key={key} bg={isSelected(key) ? "dark.7" : undefined}>
                  <Table.Td w={40}>
                    <Checkbox
                      aria-label={`Select ${db.name}`}
                      checked={isSelected(key)}
                      disabled={busy}
                      onChange={() => toggle(key)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <ResourceLink to={databasePath(db)}>{db.name}</ResourceLink>
                      {db.managedByKmc ? (
                        <Badge size="xs" variant="light" color="accent">
                          kmc
                        </Badge>
                      ) : null}
                    </Group>
                    {db.currentPrimary ? (
                      <Text size="xs" c="dimmed">
                        primary {db.currentPrimary}
                      </Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={databasesListPath({ cluster: db.cluster })}
                      dimmed
                    >
                      {db.cluster}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={databasesListPath({
                        cluster: db.cluster,
                        namespace: db.namespace,
                      })}
                      dimmed
                    >
                      {db.namespace}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={databasesListPath({
                        cluster: db.cluster,
                        status: db.status,
                      })}
                      underline="never"
                    >
                      <StatusBadge status={db.status} />
                    </ResourceLink>
                    {db.phase && db.phase !== db.status ? (
                      <Text size="xs" c="dimmed" mt={2} lineClamp={1} maw={220}>
                        {db.phase}
                      </Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {db.readyInstances}/{db.instances}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{db.postgresVersion ?? "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{db.storageSize ?? "—"}</Text>
                    {db.storageClass ? (
                      <Text size="xs" c="dimmed">
                        {db.storageClass}
                      </Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={db.age || "unknown"}>
                      <Text size="sm" c="dimmed">
                        {formatAge(db.age)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Menu shadow="md" width={180} position="bottom-end">
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`Actions for ${db.name}`}
                        >
                          <IconDotsVertical size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item component={Link} to={databasePath(db)}>
                          Open
                        </Menu.Item>
                        <Menu.Item
                          component={Link}
                          to={databaseTerminalPath(db)}
                          leftSection={<IconTerminal2 size={14} />}
                          disabled={!canOpenDatabaseTerminal(db)}
                          title={
                            canOpenDatabaseTerminal(db)
                              ? "Open psql as the app user"
                              : "psql requires a primary instance"
                          }
                        >
                          Terminal
                        </Menu.Item>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          disabled={busy}
                          onClick={() => setDeleteTarget(db)}
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
        resourceName={deleteTarget?.name ?? ""}
        identity={
          deleteTarget
            ? `${deleteTarget.cluster}/${deleteTarget.namespace}/${deleteTarget.name}`
            : ""
        }
        title="Delete database"
        confirmLabel="Delete cluster"
        warning={
          deleteTarget && !deleteTarget.managedByKmc
            ? "This cluster was not created by kmc. Deleting removes the CloudNativePG Cluster and typically its PVCs — data will be lost."
            : "Deletes the CloudNativePG Cluster and typically its PVCs. Data will be lost."
        }
        loading={busy}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          const target = deleteTarget;
          setDeleteTarget(null);
          fetcher.submit(
            {
              intent: "delete",
              cluster: target.cluster,
              namespace: target.namespace,
              name: target.name,
            },
            { method: "post" },
          );
        }}
      />

      <ConfirmBulkDeleteModal
        opened={bulkDeleteOpen}
        count={selectedItems.length}
        identities={selectedItems.map(resourceKey)}
        title={`Delete ${selectedItems.length} database${selectedItems.length === 1 ? "" : "s"}`}
        confirmLabel={`Delete ${selectedItems.length}`}
        warning="Deletes CloudNativePG Cluster resources and typically their PVCs. Data will be lost."
        loading={busy}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit(
            {
              intent: "bulk-delete",
              targets: bulkTargetsJson(selectedItems),
            },
            { method: "post" },
          );
        }}
      />
    </Stack>
  );
}
