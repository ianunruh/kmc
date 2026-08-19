import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Group,
  Menu,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconDotsVertical, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/routers._index";
import {
  BulkActionBar,
  ConfirmBulkDeleteModal,
  ConfirmDeleteModal,
  FilterBar,
  PageHeader,
  ResourceLink,
  ResourceTable,
  StatusBadge,
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
import { routerPath, routersListPath, vpcPath } from "~/lib/format";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import { useRefresh } from "~/lib/refresh";
import type { BulkActionResult, RouterSummary } from "~/lib/types";
import { resourceKey, useRowSelection } from "~/lib/use-row-selection";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { deleteRouter, listRouters } from "~/vpcs/routers.server";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Routers · kmc" }];
}

export const loader = tracedLoader(async ({ request }: Route.LoaderArgs) => {
  return listRouters(clusterFromRequest(request) ?? undefined);
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
      await deleteRouter(t.cluster, t.namespace, t.name);
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
    await deleteRouter(cluster, namespace, name);
    return { ok: true, intent };
  } catch (err) {
    return actionFailure("router.delete", err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

type ActionResult = { ok?: boolean; error?: string; intent?: string } | BulkActionResult;

export default function RoutersPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [deleteTarget, setDeleteTarget] = useState<RouterSummary | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const namespaces = useMemo(() => {
    const set = new Set(items.map((r) => r.namespace));
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((r) => {
      if (filters.cluster && r.cluster !== filters.cluster) return false;
      if (filters.namespace && r.namespace !== filters.namespace) return false;
      return matchesQuery(qDraft, [r.name, r.namespace, r.cluster, ...r.vpcNames]);
    });
  }, [items, filters.cluster, filters.namespace, qDraft]);

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
    () => filtered.filter((r) => selected.has(resourceKey(r))),
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
      notifyActionSuccess("Done", "Router deleted");
      refreshNow();
    }
  });

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Routers"
        description="Shared VPC routers (DHCP + DNS). Multi-VPC attach at create or later via hotplug; optional external Multus for SNAT and floating IPs."
        actions={
          <Button
            component={Link}
            to="/routers/create"
            leftSection={<IconPlus size={16} />}
          >
            Create router
          </Button>
        }
      />

      {unreachable.length > 0 && (
        <Alert color="orange" variant="light" title="Some clusters unreachable">
          {unreachable.map((c) => c.id).join(", ")}
        </Alert>
      )}

      <FilterBar>
        <TextInput
          placeholder="Filter…"
          leftSection={<IconSearch size={14} />}
          value={qDraft}
          onChange={(e) => setQ(e.currentTarget.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <Select
          placeholder="Cluster"
          clearable
          data={clusters.map((c) => ({
            value: c.id,
            label: c.reachable ? c.id : `${c.id} (down)`,
          }))}
          value={filters.cluster || null}
          onChange={(v) => setFilter("cluster", v)}
          w={160}
        />
        <Select
          placeholder="Namespace"
          clearable
          data={namespaces}
          value={filters.namespace || null}
          onChange={(v) => setFilter("namespace", v)}
          w={160}
        />
      </FilterBar>

      <Stack gap="sm">
        <BulkActionBar selectedCount={selectedCount} onClear={clear} disabled={busy}>
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
          emptyMessage="No routers. Create one and attach a VPC with private IPAM for DHCP/DNS."
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
            "Namespace",
            "Cluster",
            "VPCs",
            "Agent",
            "Age",
            "",
          ]}
        >
          {filtered.map((r) => {
            const key = resourceKey(r);
            return (
              <Table.Tr key={key} bg={isSelected(key) ? "dark.7" : undefined}>
                <Table.Td w={40}>
                  <Checkbox
                    aria-label={`Select ${r.name}`}
                    checked={isSelected(key)}
                    disabled={busy}
                    onChange={() => toggle(key)}
                  />
                </Table.Td>
                <Table.Td>
                  <ResourceLink to={routerPath(r)}>{r.name}</ResourceLink>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {r.namespace}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <ResourceLink to={routersListPath({ cluster: r.cluster })} dimmed>
                    {r.cluster}
                  </ResourceLink>
                </Table.Td>
                <Table.Td>
                  {r.vpcNames.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  ) : (
                    <Group gap={4} wrap="wrap">
                      {r.vpcNames.map((vpc) => (
                        <ResourceLink
                          key={vpc}
                          to={vpcPath({
                            cluster: r.cluster,
                            namespace: r.namespace,
                            name: vpc,
                          })}
                        >
                          {vpc}
                        </ResourceLink>
                      ))}
                    </Group>
                  )}
                </Table.Td>
                <Table.Td>
                  {r.agentStatus ? (
                    <StatusBadge status={r.agentStatus} />
                  ) : (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {r.age}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Menu withinPortal position="bottom-end">
                    <Menu.Target>
                      <ActionIcon variant="subtle" disabled={busy}>
                        <IconDotsVertical size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        onClick={() => setDeleteTarget(r)}
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

      <ConfirmDeleteModal
        opened={Boolean(deleteTarget)}
        resourceName={deleteTarget?.name ?? ""}
        identity={
          deleteTarget
            ? `${deleteTarget.cluster}/${deleteTarget.namespace}/${deleteTarget.name}`
            : ""
        }
        title="Delete router"
        confirmLabel="Delete router"
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
        title={`Delete ${selectedItems.length} router${selectedItems.length === 1 ? "" : "s"}`}
        confirmLabel={`Delete ${selectedItems.length}`}
        loading={busy}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit(
            {
              intent: "bulk-delete",
              targets: bulkTargetsJson(
                selectedItems.map((r) => ({
                  cluster: r.cluster,
                  namespace: r.namespace,
                  name: r.name,
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
