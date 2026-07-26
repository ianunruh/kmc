import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
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
import { Link, useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/port-forwards._index";
import {
  BulkActionBar,
  ConfirmActionModal,
  ConsolePaper,
  CopyableValue,
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
  runBulkAction,
} from "~/lib/bulk-action";
import { actionFailure } from "~/lib/errors";
import {
  portForwardCreatePath,
  portForwardsListPath,
  routerPath,
  vmPath,
  vpcPath,
} from "~/lib/format";
import {
  clusterFromRequest,
  getSearchParam,
  patchSearchParams,
} from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import { useRowSelection } from "~/lib/use-row-selection";
import { deletePortForward, listPortForwards } from "~/vpcs/vpcs.server";
import { useRefresh } from "~/lib/refresh";
import type { BulkActionResult, BulkActionSummary, PortForwardSummary } from "~/lib/types";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Port Forwards · kmc" }];
}

function portForwardKey(f: {
  cluster: string;
  namespace: string;
  vpcName: string;
  id: string;
}): string {
  return `${f.cluster}/${f.namespace}/${f.vpcName}/${f.id}`;
}

function mergeClientSkipped(
  summary: BulkActionSummary,
  clientSkipped: number,
): BulkActionSummary {
  if (clientSkipped <= 0) return summary;
  return {
    total: summary.total + clientSkipped,
    succeeded: summary.succeeded,
    skipped: summary.skipped + clientSkipped,
    failed: summary.failed,
  };
}

function parsePortForwardBulkTargets(raw: FormDataEntryValue | null): {
  targets?: Array<{
    cluster: string;
    namespace: string;
    vpcName: string;
    id: string;
  }>;
  error?: string;
} {
  if (raw == null || String(raw).trim() === "") {
    return { error: "Missing targets" };
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { error: "Targets must be a non-empty array" };
    }
    const targets: Array<{
      cluster: string;
      namespace: string;
      vpcName: string;
      id: string;
    }> = [];
    for (const t of parsed) {
      if (!t || typeof t !== "object") {
        return { error: "Invalid target entry" };
      }
      const row = t as Record<string, unknown>;
      const cluster = String(row.cluster ?? "").trim();
      const namespace = String(row.namespace ?? "").trim();
      const vpcName = String(row.vpcName ?? "").trim();
      const id = String(row.id ?? "").trim();
      if (!cluster || !namespace || !vpcName || !id) {
        return { error: "Each target needs cluster, namespace, vpcName, id" };
      }
      targets.push({ cluster, namespace, vpcName, id });
    }
    return { targets };
  } catch {
    return { error: "Invalid targets JSON" };
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  return listPortForwards(clusterFromRequest(request));
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "bulk-delete") {
    const { targets, error } = parsePortForwardBulkTargets(form.get("targets"));
    if (error || !targets) {
      return {
        ok: false,
        error: error ?? "Missing targets",
        intent,
        summary: { total: 0, succeeded: 0, skipped: 0, failed: 0 },
        results: [],
      };
    }
    return runBulkAction(
      intent,
      targets,
      (t) => `${t.cluster}/${t.namespace}/${t.vpcName}/${t.id}`,
      async (t) => {
        await deletePortForward({
          cluster: t.cluster,
          namespace: t.namespace,
          vpcName: t.vpcName,
          id: t.id,
        });
      },
    );
  }

  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const vpcName = String(form.get("vpcName") ?? "").trim();
  const id = String(form.get("id") ?? "").trim();

  if (intent !== "delete") {
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  }
  if (!cluster || !namespace || !vpcName || !id) {
    return { ok: false, error: "Missing identity", intent };
  }
  try {
    await deletePortForward({ cluster, namespace, vpcName, id });
    return { ok: true, intent };
  } catch (err) {
    return actionFailure(`portForward.${intent}`, err, {
      intent,
      cluster,
      namespace,
      vpcName,
      id,
    });
  }
}

type ActionResult =
  | { ok?: boolean; error?: string; intent?: string }
  | BulkActionResult;

export default function PortForwardsPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [searchParams, setSearchParams] = useSearchParams();
  const vpcFilter = getSearchParam(searchParams, "vpc");
  const [deleteTarget, setDeleteTarget] = useState<PortForwardSummary | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const namespaces = useMemo(() => {
    const set = new Set(items.map((f) => f.namespace));
    return Array.from(set).sort();
  }, [items]);

  const vpcs = useMemo(() => {
    const set = new Set(items.map((f) => f.vpcName));
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((f) => {
      if (filters.cluster && f.cluster !== filters.cluster) return false;
      if (filters.namespace && f.namespace !== filters.namespace) return false;
      if (vpcFilter && f.vpcName !== vpcFilter) return false;
      return matchesQuery(qDraft, [
        f.public,
        f.private,
        f.id,
        f.vpcName,
        f.namespace,
        f.cluster,
        f.targetVm,
        f.routerName,
        f.protocol,
        String(f.publicPort),
        String(f.privatePort),
      ]);
    });
  }, [items, filters.cluster, filters.namespace, vpcFilter, qDraft]);

  const visibleKeys = useMemo(() => filtered.map(portForwardKey), [filtered]);
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
    () => filtered.filter((f) => selected.has(portForwardKey(f))),
    [filtered, selected],
  );

  useFetcherResult(fetcher, (data) => {
    if (isBulkActionResult(data)) {
      if (data.error && data.results.length === 0) {
        notifyActionError("Bulk action failed", data.error, { intent: data.intent });
        return;
      }
      const summary = mergeClientSkipped(data.summary, 0);
      notifyBulkResult("deleted", summary, data.results);
      clear();
      setBulkDeleteOpen(false);
      refreshNow();
      return;
    }
    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
    } else if (data.ok) {
      notifyActionSuccess("Done", "Port forward deleted");
      refreshNow();
    }
  });

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  function toBulkTargets(list: PortForwardSummary[]) {
    return list.map((f) => ({
      cluster: f.cluster,
      namespace: f.namespace,
      vpcName: f.vpcName,
      id: f.id,
    }));
  }

  return (
    <Stack gap="md">
      <PageHeader
        title="Port Forwards"
        description={`${filtered.length} shown · ${items.length} total · publicIP:port → privateIP:port via router DNAT`}
        actions={
          <Button
            component={Link}
            to={portForwardCreatePath()}
            leftSection={<IconPlus size={16} />}
          >
            Create port forward
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
            placeholder="Search public, private, VPC, VM, port…"
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
            w={160}
          />
          <Select
            placeholder="Namespace"
            clearable
            data={namespaces}
            value={filters.namespace}
            onChange={(v) => setFilter("namespace", v)}
            w={160}
          />
          <Select
            placeholder="VPC"
            clearable
            data={vpcs}
            value={vpcFilter}
            onChange={(v) =>
              setSearchParams((prev) => patchSearchParams(prev, { vpc: v || null }), {
                replace: true,
              })
            }
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
              disabled={busy || selectedCount === 0}
              onClick={() => setBulkDeleteOpen(true)}
            >
              Delete
            </Button>
          </BulkActionBar>

          <ResourceTable
            isEmpty={filtered.length === 0}
            emptyMessage="No port forwards. Map a public port to a private VPC VM without a full floating IP."
            headers={[
              <Checkbox
                key="select-all"
                aria-label="Select all visible"
                checked={allSelected}
                indeterminate={someSelected}
                disabled={busy || filtered.length === 0}
                onChange={() => toggleAllVisible()}
              />,
              "Public",
              "Protocol",
              "Private",
              "Target VM",
              "VPC",
              "Router",
              "Cluster",
              "Agent",
              "",
            ]}
          >
            {filtered.map((f) => {
              const key = portForwardKey(f);
              return (
                <Table.Tr key={key} bg={isSelected(key) ? "dark.7" : undefined}>
                  <Table.Td w={40}>
                    <Checkbox
                      aria-label={`Select ${f.public}:${f.publicPort}`}
                      checked={isSelected(key)}
                      disabled={busy}
                      onChange={() => toggle(key)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <CopyableValue
                      value={`${f.public}:${f.publicPort}`}
                      display={`${f.public}:${f.publicPort}`}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light" color="blue">
                      {f.protocol.toUpperCase()}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <CopyableValue
                      value={`${f.private}:${f.privatePort}`}
                      display={`${f.private}:${f.privatePort}`}
                    />
                  </Table.Td>
                  <Table.Td>
                    {f.targetVm ? (
                      <ResourceLink
                        to={vmPath({
                          cluster: f.cluster,
                          namespace: f.namespace,
                          name: f.targetVm,
                        })}
                      >
                        {f.targetVm}
                      </ResourceLink>
                    ) : (
                      "—"
                    )}
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={vpcPath({
                        cluster: f.cluster,
                        namespace: f.namespace,
                        name: f.vpcName,
                      })}
                    >
                      {f.vpcName}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    {f.routerName ? (
                      <ResourceLink
                        to={routerPath({
                          cluster: f.cluster,
                          namespace: f.namespace,
                          name: f.routerName,
                        })}
                      >
                        {f.routerName}
                      </ResourceLink>
                    ) : (
                      "—"
                    )}
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink to={portForwardsListPath({ cluster: f.cluster })} dimmed>
                      {f.cluster}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    {f.agentStatus ? <StatusBadge status={f.agentStatus} /> : "—"}
                  </Table.Td>
                  <Table.Td style={{ width: 48 }}>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label="Actions"
                          disabled={busy}
                        >
                          <IconDotsVertical size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          onClick={() => setDeleteTarget(f)}
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

      <ConfirmActionModal
        opened={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        title="Delete port forward"
        confirmLabel="Delete"
        confirmColor="red"
        loading={busy}
        onConfirm={() => {
          if (!deleteTarget) return;
          fetcher.submit(
            {
              intent: "delete",
              cluster: deleteTarget.cluster,
              namespace: deleteTarget.namespace,
              vpcName: deleteTarget.vpcName,
              id: deleteTarget.id,
            },
            { method: "post" },
          );
          setDeleteTarget(null);
        }}
        message={
          deleteTarget ? (
            <>
              Remove{" "}
              <Code>
                {deleteTarget.protocol.toUpperCase()} {deleteTarget.public}:
                {deleteTarget.publicPort} → {deleteTarget.private}:{deleteTarget.privatePort}
              </Code>
              ? The public address is not released (held FIPs stay reserved).
            </>
          ) : (
            ""
          )
        }
      />

      <ConfirmActionModal
        opened={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        title={`Delete ${selectedItems.length} port forward${selectedItems.length === 1 ? "" : "s"}`}
        confirmLabel={`Delete ${selectedItems.length}`}
        confirmColor="red"
        loading={busy}
        onConfirm={() => {
          fetcher.submit(
            {
              intent: "bulk-delete",
              targets: bulkTargetsJson(toBulkTargets(selectedItems)),
            },
            { method: "post" },
          );
        }}
        message={
          <>
            Delete{" "}
            <Text span fw={700}>
              {selectedItems.length} port forward
              {selectedItems.length === 1 ? "" : "s"}
            </Text>
            ? Public addresses are not released automatically.
          </>
        }
      />
    </Stack>
  );
}
