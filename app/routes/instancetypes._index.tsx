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
import { useRefresh } from "~/lib/refresh";
import type { ClusterInstanceTypeSummary } from "~/lib/types";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Instance Types · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return listClusterInstanceTypes(clusterFromRequest(request));
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

export default function InstanceTypesPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [deleteTarget, setDeleteTarget] = useState<ClusterInstanceTypeSummary | null>(
    null,
  );

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
    } else if (data.ok) {
      notifyActionSuccess("Done", "Instance type deleted");
      refreshNow();
    }
  });

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (filters.cluster && it.cluster !== filters.cluster) return false;
      return matchesQuery(qDraft, [it.name, it.cluster, it.memory, String(it.cpu)]);
    });
  }, [items, filters.cluster, qDraft]);

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Instance Types"
        description={`${filtered.length} shown · ${items.length} total · VirtualMachineClusterInstancetype`}
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
          emptyMessage="No cluster instance types found (homelab may have none)."
          headers={["Name", "Cluster", "CPU", "Memory", "Age", ""]}
        >
          {filtered.map((it) => {
            const key = `${it.cluster}/${it.name}`;
            return (
              <Table.Tr key={key}>
                <Table.Td>
                  <ResourceLink to={instanceTypePath(it)}>{it.name}</ResourceLink>
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
                  <Text size="sm">{it.cpu}c</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{it.memory || "—"}</Text>
                </Table.Td>
                <Table.Td>
                  <Tooltip label={it.age || "unknown"}>
                    <Text size="sm" c="dimmed">
                      {formatAge(it.age)}
                    </Text>
                  </Tooltip>
                </Table.Td>
                <Table.Td>
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
                </Table.Td>
              </Table.Tr>
            );
          })}
        </ResourceTable>
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
    </Stack>
  );
}
