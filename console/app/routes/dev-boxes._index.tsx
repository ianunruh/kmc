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
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/dev-boxes._index";
import { StatusBadge } from "~/ui/status-badge";
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
  devBoxCreatePath,
  devBoxesListPath,
  formatAge,
  vmTabPath,
  vmTerminalPath,
} from "~/lib/format";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import { deleteDevBox, listDevBoxes } from "~/devboxes/devboxes.server";
import { DEVBOX_TEMPLATES, type DevBoxTemplateId } from "~/devboxes/options";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { tracedLoader } from "~/lib/request-traces.server";
import type { RootLoaderData } from "~/root";
import type { VmSummary } from "~/lib/types";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Dev Boxes · kmc" }];
}

export const loader = tracedLoader(async ({ request }: Route.LoaderArgs) => {
  return listDevBoxes(clusterFromRequest(request));
});

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const cluster = String(form.get("cluster") ?? "");
  const namespace = String(form.get("namespace") ?? "");
  const name = String(form.get("name") ?? "");
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing cluster, namespace, or name", intent };
  }
  try {
    if (intent === "delete") {
      await deleteDevBox(cluster, namespace, name);
      return { ok: true, intent };
    }
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  } catch (err) {
    return actionFailure(`devbox.${intent}`, err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

function templateLabel(id?: string): string {
  if (!id) return "—";
  const tmpl = DEVBOX_TEMPLATES[id as DevBoxTemplateId];
  return tmpl?.name ?? id;
}

export default function DevBoxesPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const { refreshNow } = useRefresh();
  const [deleteTarget, setDeleteTarget] = useState<VmSummary | null>(null);
  const root = useRouteLoaderData("root") as RootLoaderData | undefined;
  const currentOwner = root?.user?.githubLogin;
  const busy = fetcher.state !== "idle";

  const namespaces = useMemo(() => {
    const set = new Set(items.map((v) => v.namespace));
    return Array.from(set).sort();
  }, [items]);

  const statuses = useMemo(() => {
    const set = new Set(items.map((v) => v.status));
    return Array.from(set).sort();
  }, [items]);

  const owners = useMemo(() => {
    const set = new Set(items.map((v) => v.owner).filter((v): v is string => Boolean(v)));
    if (currentOwner) set.add(currentOwner);
    return Array.from(set).sort();
  }, [items, currentOwner]);

  const templates = useMemo(() => {
    const set = new Set(
      items.map((v) => v.template).filter((v): v is string => Boolean(v)),
    );
    return Array.from(set).sort();
  }, [items]);

  const ownerFilter = filters.owner ?? (currentOwner ? currentOwner : "*");

  const filtered = useMemo(() => {
    return items.filter((vm) => {
      if (filters.cluster && vm.cluster !== filters.cluster) return false;
      if (filters.namespace && vm.namespace !== filters.namespace) return false;
      if (filters.status && vm.status !== filters.status) return false;
      if (filters.template && vm.template !== filters.template) return false;
      if (ownerFilter && ownerFilter !== "*" && (vm.owner ?? "") !== ownerFilter) {
        return false;
      }
      return matchesQuery(qDraft, [
        vm.name,
        vm.namespace,
        vm.cluster,
        vm.status,
        vm.owner,
        vm.template,
      ]);
    });
  }, [
    items,
    filters.cluster,
    filters.namespace,
    filters.status,
    filters.template,
    ownerFilter,
    qDraft,
  ]);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
    } else if (data.ok) {
      notifyActionSuccess("Done", "Dev Box deleted");
      setDeleteTarget(null);
      refreshNow();
    }
  });

  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Dev Boxes"
        description={`${filtered.length} shown · ${items.length} total · opinionated VMs with Tailscale access`}
        actions={
          <Button
            component={Link}
            to={devBoxCreatePath()}
            leftSection={<IconPlus size={16} />}
          >
            Create Dev Box
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
            placeholder="Search name, owner, template…"
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
            placeholder="Owner"
            clearable={false}
            searchable
            data={[
              { value: "*", label: "Everyone" },
              ...owners.map((o) => ({ value: o, label: o })),
            ]}
            value={ownerFilter}
            onChange={(v) => setFilter("owner", v ?? "*")}
            w={180}
          />
          {templates.length > 0 && (
            <Select
              placeholder="Template"
              clearable
              data={templates.map((t) => ({
                value: t,
                label: templateLabel(t),
              }))}
              value={filters.template}
              onChange={(v) => setFilter("template", v)}
              w={200}
            />
          )}
          <Select
            placeholder="Status"
            clearable
            data={statuses}
            value={filters.status}
            onChange={(v) => setFilter("status", v)}
            w={160}
          />
        </FilterBar>

        <ResourceTable
          isEmpty={filtered.length === 0}
          emptyMessage="No Dev Boxes yet. Create one to get a VM with SSH on the internal MetalLB pool."
          headers={[
            "Name",
            "Cluster",
            "Namespace",
            "Owner",
            "Template",
            "Status",
            "Instance type",
            "Age",
            "",
          ]}
        >
          {filtered.map((vm) => (
            <Table.Tr key={`${vm.cluster}/${vm.namespace}/${vm.name}`}>
              <Table.Td>
                <ResourceLink to={vmTabPath(vm, "access")}>{vm.name}</ResourceLink>
              </Table.Td>
              <Table.Td>
                <ResourceLink to={devBoxesListPath({ cluster: vm.cluster })} dimmed>
                  {vm.cluster}
                </ResourceLink>
              </Table.Td>
              <Table.Td>
                <ResourceLink
                  to={devBoxesListPath({
                    cluster: vm.cluster,
                    namespace: vm.namespace,
                  })}
                  dimmed
                >
                  {vm.namespace}
                </ResourceLink>
              </Table.Td>
              <Table.Td>
                {vm.owner ? (
                  <ResourceLink to={devBoxesListPath({ owner: vm.owner })} dimmed>
                    {vm.owner}
                  </ResourceLink>
                ) : (
                  <Text size="sm" c="dimmed">
                    —
                  </Text>
                )}
              </Table.Td>
              <Table.Td>{templateLabel(vm.template)}</Table.Td>
              <Table.Td>
                <StatusBadge status={vm.status} />
              </Table.Td>
              <Table.Td>
                <Text size="sm" c={vm.instanceType ? undefined : "dimmed"}>
                  {vm.instanceType ?? "—"}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {formatAge(vm.age)}
                </Text>
              </Table.Td>
              <Table.Td>
                <Menu shadow="md" position="bottom-end" width={160}>
                  <Menu.Target>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={`Actions for ${vm.name}`}
                    >
                      <IconDotsVertical size={16} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      component={Link}
                      to={vmTerminalPath(vm)}
                      leftSection={<IconTerminal2 size={14} />}
                    >
                      Terminal
                    </Menu.Item>
                    <Menu.Item
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      disabled={busy}
                      onClick={() => setDeleteTarget(vm)}
                    >
                      Delete
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Table.Td>
            </Table.Tr>
          ))}
        </ResourceTable>
      </ConsolePaper>

      <ConfirmDeleteModal
        opened={deleteTarget != null}
        resourceName={deleteTarget?.name ?? ""}
        identity={
          deleteTarget
            ? `${deleteTarget.cluster}/${deleteTarget.namespace}/${deleteTarget.name}`
            : ""
        }
        title="Delete Dev Box"
        confirmLabel="Delete"
        warning="Deletes the VM, cloud-init Secret, SSH LoadBalancer, and IDE route (if any)."
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
        }}
      />
    </Stack>
  );
}
