import {
  ActionIcon,
  Alert,
  Button,
  Menu,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import {
  IconDotsVertical,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/routers._index";
import {
  ConfirmDeleteModal,
  FilterBar,
  PageHeader,
  ResourceLink,
  ResourceTable,
  StatusBadge,
  Table,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import { routerPath, routersListPath } from "~/lib/format";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import { useRefresh } from "~/lib/refresh";
import type { RouterSummary } from "~/lib/types";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { deleteRouter, listRouters } from "~/vpcs/routers.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Routers · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return listRouters(clusterFromRequest(request) ?? undefined);
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const cluster = String(form.get("cluster") ?? "");
  const namespace = String(form.get("namespace") ?? "");
  const name = String(form.get("name") ?? "");
  const force = String(form.get("force") ?? "") === "true";

  if (intent !== "delete") {
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  }
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing identity", intent };
  }
  try {
    await deleteRouter(cluster, namespace, name, { force });
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

export default function RoutersPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [deleteTarget, setDeleteTarget] = useState<RouterSummary | null>(null);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
    } else if (data.ok) {
      notifyActionSuccess("Done", "Router deleted");
      refreshNow();
    }
  });

  const namespaces = useMemo(() => {
    const set = new Set(items.map((r) => r.namespace));
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((r) => {
      if (filters.cluster && r.cluster !== filters.cluster) return false;
      if (filters.namespace && r.namespace !== filters.namespace) return false;
      return matchesQuery(qDraft, [
        r.name,
        r.namespace,
        r.cluster,
        ...r.vpcNames,
      ]);
    });
  }, [items, filters.cluster, filters.namespace, qDraft]);

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Routers"
        description="Shared VPC routers (DHCP + DNS). One router can attach multiple VPCs; optional external gateway comes later."
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

      <ResourceTable
        isEmpty={filtered.length === 0}
        emptyMessage="No routers. Create one and attach a VPC with private IPAM for DHCP/DNS."
        headers={["Name", "Namespace", "Cluster", "VPCs", "Agent", "Age", ""]}
      >
        {filtered.map((r) => (
          <Table.Tr key={`${r.cluster}/${r.namespace}/${r.name}`}>
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
              <Text size="sm" ff="monospace">
                {r.vpcNames.length ? r.vpcNames.join(", ") : "—"}
              </Text>
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
        ))}
      </ResourceTable>

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
    </Stack>
  );
}
