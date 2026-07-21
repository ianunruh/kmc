import {
  ActionIcon,
  Alert,
  Button,
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
  ConfirmDeleteModal,
  ConsolePaper,
  FilterBar,
  PageHeader,
  ResourceLink,
  ResourceTable,
  Table,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
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
import type { IngressSummary } from "~/lib/types";
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

export default function IngressesPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [deleteTarget, setDeleteTarget] = useState<IngressSummary | null>(null);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
    } else if (data.ok) {
      notifyActionSuccess("Done", "Ingress and companion Service deleted");
      refreshNow();
    }
  });

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

        <ResourceTable
          isEmpty={filtered.length === 0}
          emptyMessage="No kmc-managed Ingresses found. Create one to expose a pod-network VM."
          headers={["Name", "Cluster", "Namespace", "Hosts", "VM", "Class", "Age", ""]}
        >
          {filtered.map((ing) => {
            const key = `${ing.cluster}/${ing.namespace}/${ing.name}`;
            return (
              <Table.Tr key={key}>
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
    </Stack>
  );
}
