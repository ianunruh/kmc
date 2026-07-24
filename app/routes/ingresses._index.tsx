import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Menu,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { IconDotsVertical, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/ingresses._index";
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
  formatAge,
  ingressPath,
  ingressesListPath,
  vmPath,
} from "~/lib/format";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import { deleteIngress, listIngresses } from "~/ingresses/ingresses.server";
import { useRefresh } from "~/lib/refresh";
import type { BulkActionResult, IngressSummary } from "~/lib/types";
import { resourceKey, useRowSelection } from "~/lib/use-row-selection";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Ingresses · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return listIngresses(clusterFromRequest(request));
}

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
      await deleteIngress(t.cluster, t.namespace, t.name);
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
    await deleteIngress(cluster, namespace, name);
    return { ok: true, intent };
  } catch (err) {
    return actionFailure("ingress.delete", err, {
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

export default function IngressesPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [deleteTarget, setDeleteTarget] = useState<IngressSummary | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const namespaces = useMemo(() => {
    const set = new Set(items.map((ing) => ing.namespace));
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((ing) => {
      if (filters.cluster && ing.cluster !== filters.cluster) return false;
      if (filters.namespace && ing.namespace !== filters.namespace) return false;
      return matchesQuery(qDraft, [
        ing.name,
        ing.namespace,
        ing.cluster,
        ing.vmName,
        ing.className,
        ...(ing.hosts ?? []),
        ing.address,
      ]);
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
    () => filtered.filter((ing) => selected.has(resourceKey(ing))),
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
      notifyActionSuccess("Done", "Ingress and companion Service deleted");
      refreshNow();
    }
  });

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Ingresses"
        description={`${filtered.length} shown · ${items.length} total · bound to VMs via Service`}
        actions={
          <Button
            component={Link}
            to="/ingresses/create"
            leftSection={<IconPlus size={16} />}
          >
            Create Ingress
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
            placeholder="Search name, host, VM, namespace…"
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
            emptyMessage="No kmc-managed Ingresses found. Create one to expose a pod-network VM."
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
              "Hosts",
              "VM",
              "Class",
              "Age",
              "",
            ]}
          >
            {filtered.map((ing) => {
              const key = resourceKey(ing);
              return (
                <Table.Tr key={key} bg={isSelected(key) ? "dark.7" : undefined}>
                  <Table.Td w={40}>
                    <Checkbox
                      aria-label={`Select ${ing.name}`}
                      checked={isSelected(key)}
                      disabled={busy}
                      onChange={() => toggle(key)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink to={ingressPath(ing)}>{ing.name}</ResourceLink>
                    {ing.address && (
                      <Text size="xs" c="dimmed">
                        {ing.address}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink to={ingressesListPath({ cluster: ing.cluster })} dimmed>
                      {ing.cluster}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={ingressesListPath({
                        cluster: ing.cluster,
                        namespace: ing.namespace,
                      })}
                      dimmed
                    >
                      {ing.namespace}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {ing.hosts.length > 0 ? ing.hosts.join(", ") : "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {ing.vmName ? (
                      <ResourceLink
                        to={vmPath({
                          cluster: ing.cluster,
                          namespace: ing.namespace,
                          name: ing.vmName,
                        })}
                        dimmed
                      >
                        {ing.vmName}
                      </ResourceLink>
                    ) : (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {ing.className ?? "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={ing.age || "unknown"}>
                      <Text size="sm" c="dimmed">
                        {formatAge(ing.age)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Menu shadow="md" width={160} position="bottom-end">
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`Actions for ${ing.name}`}
                        >
                          <IconDotsVertical size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          disabled={busy}
                          onClick={() => setDeleteTarget(ing)}
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
        title="Delete Ingress"
        confirmLabel="Delete Ingress"
        warning="Also deletes the companion ClusterIP Service with the same name. The VirtualMachine is not affected."
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
        title={`Delete ${selectedItems.length} ingress${selectedItems.length === 1 ? "" : "es"}`}
        confirmLabel={`Delete ${selectedItems.length}`}
        warning="Also deletes the companion ClusterIP Service with the same name. The VirtualMachine is not affected."
        loading={busy}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit(
            {
              intent: "bulk-delete",
              targets: bulkTargetsJson(
                selectedItems.map((ing) => ({
                  cluster: ing.cluster,
                  namespace: ing.namespace,
                  name: ing.name,
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
