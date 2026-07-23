import {
  ActionIcon,
  Alert,
  Badge,
  Button,
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
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/namespaces._index";
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
  formatDateTime,
  namespacePath,
  namespacesListPath,
  vmsListPath,
} from "~/lib/format";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import { deleteNamespace, listNamespaces } from "~/namespaces/namespaces.server";
import { useRefresh } from "~/lib/refresh";
import type { NamespaceSummary } from "~/lib/types";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Namespaces · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return listNamespaces(clusterFromRequest(request));
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const cluster = String(form.get("cluster") ?? "");
  const name = String(form.get("name") ?? "");

  if (intent !== "delete") {
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  }
  if (!cluster || !name) {
    return { ok: false, error: "Missing identity", intent };
  }
  try {
    await deleteNamespace(cluster, name);
    return { ok: true, intent };
  } catch (err) {
    return actionFailure("namespace.delete", err, {
      intent,
      cluster,
      name,
    });
  }
}

export default function NamespacesPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [deleteTarget, setDeleteTarget] = useState<NamespaceSummary | null>(null);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
    } else if (data.ok) {
      notifyActionSuccess("Done", "Namespace deleted");
      refreshNow();
    }
  });

  const filtered = useMemo(() => {
    return items.filter((ns) => {
      if (filters.cluster && ns.cluster !== filters.cluster) return false;
      return matchesQuery(qDraft, [ns.name, ns.cluster, ns.phase]);
    });
  }, [items, filters.cluster, qDraft]);

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Namespaces"
        description={`${filtered.length} shown · ${items.length} total · projects labeled for VM workloads`}
        actions={
          <Button
            component={Link}
            to="/namespaces/create"
            leftSection={<IconPlus size={16} />}
          >
            Create Namespace
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
            placeholder="Search name, cluster…"
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
        </FilterBar>

        <ResourceTable
          isEmpty={filtered.length === 0}
          emptyMessage="No vm-allowed namespaces found. Create one to start launching VMs and VPCs."
          headers={["Name", "Cluster", "Phase", "Age", ""]}
        >
          {filtered.map((ns) => {
            const key = `${ns.cluster}/${ns.name}`;
            return (
              <Table.Tr key={key}>
                <Table.Td>
                  <ResourceLink to={namespacePath(ns)}>{ns.name}</ResourceLink>
                  {ns.managedByKmc && (
                    <Text size="xs" c="dimmed">
                      managed by kmc
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <ResourceLink
                    to={namespacesListPath({ cluster: ns.cluster })}
                    dimmed
                  >
                    {ns.cluster}
                  </ResourceLink>
                </Table.Td>
                <Table.Td>
                  <Badge
                    variant="light"
                    color={ns.phase === "Active" ? "teal" : "gray"}
                  >
                    {ns.phase}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Tooltip label={ns.age ? formatDateTime(ns.age) : "unknown"}>
                    <Text size="sm" c="dimmed">
                      {formatAge(ns.age)}
                    </Text>
                  </Tooltip>
                </Table.Td>
                <Table.Td>
                  <Menu shadow="md" width={180} position="bottom-end">
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label={`Actions for ${ns.name}`}
                      >
                        <IconDotsVertical size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        component={Link}
                        to={vmsListPath({
                          cluster: ns.cluster,
                          namespace: ns.name,
                        })}
                      >
                        View VMs
                      </Menu.Item>
                      <Menu.Item
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        disabled={busy}
                        onClick={() => setDeleteTarget(ns)}
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
            ? `${deleteTarget.cluster}/${deleteTarget.name}`
            : null
        }
        title="Delete Namespace"
        confirmLabel="Delete Namespace"
        warning="Deletes the Kubernetes Namespace and cascades namespaced resources. Blocked while VirtualMachines still exist."
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
    </Stack>
  );
}
