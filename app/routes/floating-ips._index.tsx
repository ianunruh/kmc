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
  Tooltip,
} from "@mantine/core";
import {
  IconDotsVertical,
  IconLink,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUnlink,
} from "@tabler/icons-react";
import { useMemo, useRef, useState } from "react";
import { Link, useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/floating-ips._index";
import {
  BulkActionBar,
  ConfirmActionModal,
  ConsolePaper,
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
  parseFloatingIpBulkTargets,
  runBulkAction,
} from "~/lib/bulk-action";
import { actionFailure } from "~/lib/errors";
import { floatingIpCreatePath, floatingIpsListPath, vmPath, vpcPath } from "~/lib/format";
import {
  clusterFromRequest,
  getSearchParam,
  patchSearchParams,
} from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import { useRowSelection } from "~/lib/use-row-selection";
import {
  disassociateFloatingIp,
  listFloatingIps,
  releaseFloatingIp,
} from "~/vpcs/vpcs.server";
import { useRefresh } from "~/lib/refresh";
import type { BulkActionResult, BulkActionSummary, FloatingIpSummary } from "~/lib/types";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Floating IPs · kmc" }];
}

function floatingIpKey(f: {
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

export async function loader({ request }: Route.LoaderArgs) {
  return listFloatingIps(clusterFromRequest(request));
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "bulk-disassociate" || intent === "bulk-release") {
    const { targets, error } = parseFloatingIpBulkTargets(form.get("targets"));
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
      (t) => `${t.cluster}/${t.namespace}/${t.vpcName}/${t.idOrPublic}`,
      async (t) => {
        if (intent === "bulk-disassociate") {
          await disassociateFloatingIp({
            cluster: t.cluster,
            namespace: t.namespace,
            vpcName: t.vpcName,
            idOrPublic: t.idOrPublic,
          });
        } else {
          await releaseFloatingIp({
            cluster: t.cluster,
            namespace: t.namespace,
            vpcName: t.vpcName,
            idOrPublic: t.idOrPublic,
          });
        }
      },
    );
  }

  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const vpcName = String(form.get("vpcName") ?? "").trim();
  const idOrPublic = String(form.get("idOrPublic") ?? "").trim();

  if (intent !== "disassociate" && intent !== "release") {
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  }
  if (!cluster || !namespace || !vpcName || !idOrPublic) {
    return { ok: false, error: "Missing identity", intent };
  }
  try {
    if (intent === "disassociate") {
      await disassociateFloatingIp({
        cluster,
        namespace,
        vpcName,
        idOrPublic,
      });
    } else {
      await releaseFloatingIp({
        cluster,
        namespace,
        vpcName,
        idOrPublic,
      });
    }
    return { ok: true, intent };
  } catch (err) {
    return actionFailure(`floatingIp.${intent}`, err, {
      intent,
      cluster,
      namespace,
      vpcName,
      idOrPublic,
    });
  }
}

type ActionResult =
  | { ok?: boolean; error?: string; intent?: string }
  | BulkActionResult;

export default function FloatingIpsPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [searchParams, setSearchParams] = useSearchParams();
  const vpcFilter = getSearchParam(searchParams, "vpc");
  const [disassociateTarget, setDisassociateTarget] =
    useState<FloatingIpSummary | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<FloatingIpSummary | null>(null);
  const [bulkDisassociateOpen, setBulkDisassociateOpen] = useState(false);
  const [bulkReleaseOpen, setBulkReleaseOpen] = useState(false);
  const clientSkippedRef = useRef(0);

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
        f.state,
      ]);
    });
  }, [items, filters.cluster, filters.namespace, vpcFilter, qDraft]);

  const visibleKeys = useMemo(() => filtered.map(floatingIpKey), [filtered]);
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
    () => filtered.filter((f) => selected.has(floatingIpKey(f))),
    [filtered, selected],
  );

  const disassociableSelected = useMemo(
    () => selectedItems.filter((f) => f.state === "associated"),
    [selectedItems],
  );

  useFetcherResult(fetcher, (data) => {
    if (isBulkActionResult(data)) {
      if (data.error && data.results.length === 0) {
        notifyActionError("Bulk action failed", data.error, { intent: data.intent });
        clientSkippedRef.current = 0;
        return;
      }
      const verb =
        data.intent === "bulk-disassociate" ? "disassociated" : "released";
      const summary = mergeClientSkipped(data.summary, clientSkippedRef.current);
      clientSkippedRef.current = 0;
      notifyBulkResult(verb, summary, data.results);
      clear();
      setBulkDisassociateOpen(false);
      setBulkReleaseOpen(false);
      refreshNow();
      return;
    }
    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
    } else if (data.ok) {
      if (data.intent === "release") {
        notifyActionSuccess(
          "Done",
          "Floating IP released — public address returned to the pool",
        );
      } else {
        notifyActionSuccess(
          "Done",
          "Floating IP disassociated — public address is held (not released)",
        );
      }
      refreshNow();
    }
  });

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  function toBulkTargets(list: FloatingIpSummary[]) {
    return list.map((f) => ({
      cluster: f.cluster,
      namespace: f.namespace,
      vpcName: f.vpcName,
      idOrPublic: f.id,
    }));
  }

  return (
    <Stack gap="md">
      <PageHeader
        title="Floating IPs"
        description={`${filtered.length} shown · ${items.length} total · disassociate keeps the public IP; release returns it to the pool`}
        actions={
          <Button
            component={Link}
            to={floatingIpCreatePath()}
            leftSection={<IconPlus size={16} />}
          >
            Associate floating IP
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
            placeholder="Search public, private, VPC, VM…"
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
            <Tooltip
              label={
                disassociableSelected.length === 0
                  ? "No selected floating IPs are associated"
                  : selectedCount > disassociableSelected.length
                    ? `Disassociate ${disassociableSelected.length} · ${selectedCount - disassociableSelected.length} will be skipped`
                    : `Disassociate ${disassociableSelected.length} floating IP${disassociableSelected.length === 1 ? "" : "s"}`
              }
            >
              <span>
                <Button
                  size="xs"
                  variant="light"
                  color="orange"
                  leftSection={<IconUnlink size={14} />}
                  disabled={busy || disassociableSelected.length === 0}
                  onClick={() => setBulkDisassociateOpen(true)}
                >
                  Disassociate
                </Button>
              </span>
            </Tooltip>
            <Button
              size="xs"
              variant="light"
              color="red"
              leftSection={<IconTrash size={14} />}
              disabled={busy}
              onClick={() => setBulkReleaseOpen(true)}
            >
              Release
            </Button>
          </BulkActionBar>

          <ResourceTable
            isEmpty={filtered.length === 0}
            emptyMessage="No floating IPs. Associate a public address from an ipPools Multus network to a private VPC VM."
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
              "State",
              "Private",
              "Target VM",
              "VPC",
              "Cluster",
              "Namespace",
              "Agent",
              "",
            ]}
          >
            {filtered.map((f) => {
              const key = floatingIpKey(f);
              return (
                <Table.Tr key={key} bg={isSelected(key) ? "dark.7" : undefined}>
                  <Table.Td w={40}>
                    <Checkbox
                      aria-label={`Select ${f.public}`}
                      checked={isSelected(key)}
                      disabled={busy}
                      onChange={() => toggle(key)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Code>
                      {f.public}/{f.prefix}
                    </Code>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      size="sm"
                      variant="light"
                      color={f.state === "associated" ? "teal" : "yellow"}
                    >
                      {f.state}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {f.private ? <Code>{f.private}</Code> : (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    )}
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
                    <ResourceLink to={floatingIpsListPath({ cluster: f.cluster })} dimmed>
                      {f.cluster}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {f.namespace}
                    </Text>
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
                        {f.state === "held" ? (
                          <Menu.Item
                            component={Link}
                            to={floatingIpCreatePath({
                              cluster: f.cluster,
                              namespace: f.namespace,
                              vpc: f.vpcName,
                              publicIpv4: f.public,
                            })}
                            leftSection={<IconLink size={14} />}
                          >
                            Associate…
                          </Menu.Item>
                        ) : (
                          <Menu.Item
                            leftSection={<IconUnlink size={14} />}
                            onClick={() => setDisassociateTarget(f)}
                          >
                            Disassociate (keep)
                          </Menu.Item>
                        )}
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          onClick={() => setReleaseTarget(f)}
                        >
                          Release to pool
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
        opened={disassociateTarget != null}
        onClose={() => setDisassociateTarget(null)}
        title="Disassociate floating IP"
        confirmLabel="Disassociate"
        confirmColor="orange"
        loading={busy}
        onConfirm={() => {
          if (!disassociateTarget) return;
          fetcher.submit(
            {
              intent: "disassociate",
              cluster: disassociateTarget.cluster,
              namespace: disassociateTarget.namespace,
              vpcName: disassociateTarget.vpcName,
              idOrPublic: disassociateTarget.id,
            },
            { method: "post" },
          );
          setDisassociateTarget(null);
        }}
        message={
          disassociateTarget ? (
            <>
              Unmap{" "}
              <Code>
                {disassociateTarget.public} → {disassociateTarget.private}
              </Code>{" "}
              on VPC <Code>{disassociateTarget.vpcName}</Code>? The public address stays
              reserved (held) for this VPC until you release it.
            </>
          ) : (
            ""
          )
        }
      />

      <ConfirmActionModal
        opened={releaseTarget != null}
        onClose={() => setReleaseTarget(null)}
        title="Release floating IP"
        confirmLabel="Release"
        confirmColor="red"
        loading={busy}
        onConfirm={() => {
          if (!releaseTarget) return;
          fetcher.submit(
            {
              intent: "release",
              cluster: releaseTarget.cluster,
              namespace: releaseTarget.namespace,
              vpcName: releaseTarget.vpcName,
              idOrPublic: releaseTarget.id,
            },
            { method: "post" },
          );
          setReleaseTarget(null);
        }}
        message={
          releaseTarget ? (
            <>
              Return <Code>{releaseTarget.public}</Code> on VPC{" "}
              <Code>{releaseTarget.vpcName}</Code> to the public IP pool?
              {releaseTarget.state === "associated" ? (
                <>
                  {" "}
                  This also drops the mapping to <Code>{releaseTarget.private}</Code>.
                </>
              ) : null}{" "}
              The address can be allocated again after the router agent reconciles.
            </>
          ) : (
            ""
          )
        }
      />

      <ConfirmActionModal
        opened={bulkDisassociateOpen}
        onClose={() => setBulkDisassociateOpen(false)}
        title={`Disassociate ${disassociableSelected.length} floating IP${disassociableSelected.length === 1 ? "" : "s"}`}
        confirmLabel={`Disassociate ${disassociableSelected.length}`}
        confirmColor="orange"
        loading={busy}
        onConfirm={() => {
          const targets = disassociableSelected;
          const clientSkipped = selectedItems.length - targets.length;
          if (targets.length === 0) {
            if (clientSkipped > 0) {
              notifyBulkResult("disassociated", {
                total: clientSkipped,
                succeeded: 0,
                skipped: clientSkipped,
                failed: 0,
              });
              clear();
            }
            setBulkDisassociateOpen(false);
            return;
          }
          clientSkippedRef.current = clientSkipped;
          fetcher.submit(
            {
              intent: "bulk-disassociate",
              targets: bulkTargetsJson(toBulkTargets(targets)),
            },
            { method: "post" },
          );
        }}
        message={
          <>
            Unmap{" "}
            <Text span fw={700}>
              {disassociableSelected.length} associated floating IP
              {disassociableSelected.length === 1 ? "" : "s"}
            </Text>
            ? Public addresses stay reserved (held) for their VPCs until released.
            {selectedCount > disassociableSelected.length ? (
              <>
                {" "}
                {selectedCount - disassociableSelected.length} selected held address
                {selectedCount - disassociableSelected.length === 1 ? "" : "es"} will be
                skipped.
              </>
            ) : null}
          </>
        }
      />

      <ConfirmActionModal
        opened={bulkReleaseOpen}
        onClose={() => setBulkReleaseOpen(false)}
        title={`Release ${selectedItems.length} floating IP${selectedItems.length === 1 ? "" : "s"}`}
        confirmLabel={`Release ${selectedItems.length}`}
        confirmColor="red"
        loading={busy}
        onConfirm={() => {
          clientSkippedRef.current = 0;
          fetcher.submit(
            {
              intent: "bulk-release",
              targets: bulkTargetsJson(toBulkTargets(selectedItems)),
            },
            { method: "post" },
          );
        }}
        message={
          <>
            Return{" "}
            <Text span fw={700}>
              {selectedItems.length} floating IP
              {selectedItems.length === 1 ? "" : "s"}
            </Text>{" "}
            to the public IP pool? Associated mappings are dropped. Addresses can be
            allocated again after the router agent reconciles.
          </>
        }
      />
    </Stack>
  );
}
