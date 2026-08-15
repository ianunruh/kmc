import {
  ActionIcon,
  Alert,
  Anchor,
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
import { IconDotsVertical, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/http-routes._index";
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
  httpRouteEditPath,
  httpRouteHostUrl,
  httpRoutePath,
  httpRoutesListPath,
  vmPath,
} from "~/lib/format";
import { CopyButton } from "~/ui";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import { deleteHttpRoute, listHttpRoutes } from "~/httproutes/httproutes.server";
import { useRefresh } from "~/lib/refresh";
import type { BulkActionResult, HttpRouteSummary } from "~/lib/types";
import { resourceKey, useRowSelection } from "~/lib/use-row-selection";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "HTTP Routes · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return listHttpRoutes(clusterFromRequest(request));
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
      await deleteHttpRoute(t.cluster, t.namespace, t.name);
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
    await deleteHttpRoute(cluster, namespace, name);
    return { ok: true, intent };
  } catch (err) {
    return actionFailure("httproute.delete", err, {
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

function parentLabel(route: HttpRouteSummary): string {
  const parent = route.parentRefs[0];
  if (!parent) return "—";
  const ns = parent.namespace && parent.namespace !== route.namespace
    ? `${parent.namespace}/`
    : "";
  return `${ns}${parent.name}`;
}

export default function HttpRoutesPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [deleteTarget, setDeleteTarget] = useState<HttpRouteSummary | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const namespaces = useMemo(() => {
    const set = new Set(items.map((route) => route.namespace));
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((route) => {
      if (filters.cluster && route.cluster !== filters.cluster) return false;
      if (filters.namespace && route.namespace !== filters.namespace) return false;
      return matchesQuery(qDraft, [
        route.name,
        route.namespace,
        route.cluster,
        route.vmName,
        route.membershipMode,
        parentLabel(route),
        ...(route.hosts ?? []),
        route.address,
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
    () => filtered.filter((route) => selected.has(resourceKey(route))),
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
      notifyActionSuccess("Done", "HTTPRoute and companion Service deleted");
      refreshNow();
    }
  });

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="HTTP Routes"
        description={`${filtered.length} shown · ${items.length} total · HTTPRoute via Gateway API (single VM, group, or labels)`}
        actions={
          <Button
            component={Link}
            to="/http-routes/create"
            leftSection={<IconPlus size={16} />}
          >
            Create HTTP Route
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
            placeholder="Search name, host, VM, Gateway, namespace…"
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
            emptyMessage="No kmc-managed HTTPRoutes yet. Create one to expose pod-network VM(s) over HTTP(S) via a Gateway."
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
              "Gateway",
              "Backend",
              "Endpoints",
              "Age",
              "",
            ]}
          >
            {filtered.map((route) => {
              const key = resourceKey(route);
              return (
                <Table.Tr key={key} bg={isSelected(key) ? "dark.7" : undefined}>
                  <Table.Td w={40}>
                    <Checkbox
                      aria-label={`Select ${route.name}`}
                      checked={isSelected(key)}
                      disabled={busy}
                      onChange={() => toggle(key)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink to={httpRoutePath(route)}>{route.name}</ResourceLink>
                    {route.address && (
                      <Text size="xs" c="dimmed">
                        {route.address}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink to={httpRoutesListPath({ cluster: route.cluster })} dimmed>
                      {route.cluster}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={httpRoutesListPath({
                        cluster: route.cluster,
                        namespace: route.namespace,
                      })}
                      dimmed
                    >
                      {route.namespace}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    {route.hosts.length === 0 ? (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    ) : (
                      <Group gap="xs" wrap="wrap">
                        {route.hosts.map((host) => (
                          <Group key={host} gap={2} wrap="nowrap">
                            <Anchor
                              href={httpRouteHostUrl(host, route.httpsHosts)}
                              target="_blank"
                              rel="noopener noreferrer"
                              size="sm"
                            >
                              {host}
                            </Anchor>
                            <CopyButton
                              value={httpRouteHostUrl(host, route.httpsHosts)}
                              label="Copy URL"
                              size="xs"
                            />
                          </Group>
                        ))}
                      </Group>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {parentLabel(route)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {route.membershipMode === "group" ? (
                      <Text size="sm" c="dimmed">
                        VM group
                      </Text>
                    ) : route.membershipMode === "labels" ? (
                      <Text size="sm" c="dimmed">
                        Labels
                      </Text>
                    ) : route.vmName ? (
                      <ResourceLink
                        to={vmPath({
                          cluster: route.cluster,
                          namespace: route.namespace,
                          name: route.vmName,
                        })}
                        dimmed
                      >
                        {route.vmName}
                      </ResourceLink>
                    ) : (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text
                      size="sm"
                      c={
                        route.endpointsTotal != null &&
                        (route.endpointsReady ?? 0) === 0
                          ? "orange"
                          : "dimmed"
                      }
                    >
                      {route.endpointsTotal != null
                        ? `${route.endpointsReady ?? 0}/${route.endpointsTotal}`
                        : "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={route.age || "unknown"}>
                      <Text size="sm" c="dimmed">
                        {formatAge(route.age)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Menu shadow="md" width={160} position="bottom-end">
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`Actions for ${route.name}`}
                        >
                          <IconDotsVertical size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item component={Link} to={httpRoutePath(route)}>
                          Open
                        </Menu.Item>
                        <Menu.Item component={Link} to={httpRouteEditPath(route)}>
                          Edit
                        </Menu.Item>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          disabled={busy}
                          onClick={() => setDeleteTarget(route)}
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
        title="Delete HTTP Route"
        confirmLabel="Delete HTTP Route"
        warning="Also deletes the companion ClusterIP Service with the same name. Group membership labels are cleared. VirtualMachines are not deleted."
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
        title={`Delete ${selectedItems.length} HTTP route${selectedItems.length === 1 ? "" : "s"}`}
        confirmLabel={`Delete ${selectedItems.length}`}
        warning="Also deletes the companion ClusterIP Service with the same name. Group membership labels are cleared. VirtualMachines are not deleted."
        loading={busy}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit(
            {
              intent: "bulk-delete",
              targets: bulkTargetsJson(
                selectedItems.map((route) => ({
                  cluster: route.cluster,
                  namespace: route.namespace,
                  name: route.name,
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
