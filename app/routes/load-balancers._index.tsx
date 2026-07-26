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
import type { Route } from "./+types/load-balancers._index";
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
  loadBalancerPath,
  loadBalancersListPath,
  vmPath,
} from "~/lib/format";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import {
  deleteLoadBalancer,
  listLoadBalancers,
} from "~/backends/backends.server";
import { useRefresh } from "~/lib/refresh";
import type { BackendSummary, BulkActionResult } from "~/lib/types";
import { resourceKey, useRowSelection } from "~/lib/use-row-selection";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Load Balancers · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return listLoadBalancers(clusterFromRequest(request));
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
      await deleteLoadBalancer(t.cluster, t.namespace, t.name);
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
    await deleteLoadBalancer(cluster, namespace, name);
    return { ok: true, intent };
  } catch (err) {
    return actionFailure("loadbalancer.delete", err, {
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

function membershipLabel(lb: BackendSummary): string {
  if (lb.membership.mode === "single-vm") return lb.vmName ?? "Single VM";
  if (lb.membership.mode === "group") return "VM group";
  if (lb.membership.mode === "labels") return "Labels";
  return "—";
}

export default function LoadBalancersPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [deleteTarget, setDeleteTarget] = useState<BackendSummary | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const namespaces = useMemo(() => {
    const set = new Set(items.map((lb) => lb.namespace));
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((lb) => {
      if (filters.cluster && lb.cluster !== filters.cluster) return false;
      if (filters.namespace && lb.namespace !== filters.namespace) return false;
      return matchesQuery(qDraft, [
        lb.name,
        lb.namespace,
        lb.cluster,
        lb.vmName,
        lb.membership.mode,
        lb.externalAddress,
        ...Object.entries(lb.selector).map(([k, v]) => `${k}=${v}`),
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
    () => filtered.filter((lb) => selected.has(resourceKey(lb))),
    [filtered, selected],
  );

  useFetcherResult(fetcher, (data) => {
    if (isBulkActionResult(data)) {
      if (data.error && data.results.length === 0) {
        notifyActionError("Bulk action failed", data.error, {
          intent: data.intent,
        });
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
      notifyActionSuccess("Done", "Load balancer deleted");
      refreshNow();
    }
  });

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Load Balancers"
        description={`${filtered.length} shown · ${items.length} total · L4 Service type LoadBalancer (MetalLB / cloud LB)`}
        actions={
          <Button
            component={Link}
            to="/load-balancers/create"
            leftSection={<IconPlus size={16} />}
          >
            Create Load Balancer
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
            placeholder="Search name, VIP, VM, selector…"
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
            emptyMessage="No load balancers yet. Create one to expose VMs on a cluster LoadBalancer VIP."
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
              "External",
              "Backend",
              "Ports",
              "Age",
              "",
            ]}
          >
            {filtered.map((lb) => {
              const key = resourceKey(lb);
              return (
                <Table.Tr key={key} bg={isSelected(key) ? "dark.7" : undefined}>
                  <Table.Td w={40}>
                    <Checkbox
                      aria-label={`Select ${lb.name}`}
                      checked={isSelected(key)}
                      disabled={busy}
                      onChange={() => toggle(key)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink to={loadBalancerPath(lb)}>{lb.name}</ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={loadBalancersListPath({ cluster: lb.cluster })}
                      dimmed
                    >
                      {lb.cluster}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={loadBalancersListPath({
                        cluster: lb.cluster,
                        namespace: lb.namespace,
                      })}
                      dimmed
                    >
                      {lb.namespace}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c={lb.externalAddress ? undefined : "dimmed"}>
                      {lb.externalAddress ?? "Pending"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {lb.membership.mode === "single-vm" && lb.vmName ? (
                      <ResourceLink
                        to={vmPath({
                          cluster: lb.cluster,
                          namespace: lb.namespace,
                          name: lb.vmName,
                        })}
                        dimmed
                      >
                        {lb.vmName}
                      </ResourceLink>
                    ) : (
                      <Text size="sm" c="dimmed">
                        {membershipLabel(lb)}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {lb.ports.length > 0
                        ? lb.ports
                            .map(
                              (p) =>
                                `${p.port}→${p.targetPort}/${p.protocol ?? "TCP"}`,
                            )
                            .join(", ")
                        : "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={lb.age || "unknown"}>
                      <Text size="sm" c="dimmed">
                        {formatAge(lb.age)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Menu shadow="md" width={160} position="bottom-end">
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`Actions for ${lb.name}`}
                        >
                          <IconDotsVertical size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item component={Link} to={loadBalancerPath(lb)}>
                          Open
                        </Menu.Item>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          onClick={() => setDeleteTarget(lb)}
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
        title="Delete load balancer"
        confirmLabel="Delete"
        warning="Deletes the LoadBalancer Service. Group membership labels are cleared. VirtualMachines are not deleted."
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
        title={`Delete ${selectedItems.length} load balancer${selectedItems.length === 1 ? "" : "s"}`}
        confirmLabel={`Delete ${selectedItems.length}`}
        warning="Deletes each LoadBalancer Service. Group membership labels are cleared. VirtualMachines are not deleted."
        loading={busy}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit(
            {
              intent: "bulk-delete",
              targets: bulkTargetsJson(
                selectedItems.map((lb) => ({
                  cluster: lb.cluster,
                  namespace: lb.namespace,
                  name: lb.name,
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
