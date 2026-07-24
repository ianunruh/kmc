import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Menu,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import {
  IconDotsVertical,
  IconLink,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUnlink,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/floating-ips._index";
import {
  ConfirmActionModal,
  ConsolePaper,
  FilterBar,
  PageHeader,
  ResourceLink,
  ResourceTable,
  StatusBadge,
  Table,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import { floatingIpCreatePath, floatingIpsListPath, vmPath, vpcPath } from "~/lib/format";
import {
  clusterFromRequest,
  getSearchParam,
  patchSearchParams,
} from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import {
  disassociateFloatingIp,
  listFloatingIps,
  releaseFloatingIp,
} from "~/vpcs/vpcs.server";
import { useRefresh } from "~/lib/refresh";
import type { FloatingIpSummary } from "~/lib/types";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Floating IPs · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return listFloatingIps(clusterFromRequest(request));
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
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

export default function FloatingIpsPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string;
    intent?: string;
  }>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [searchParams, setSearchParams] = useSearchParams();
  const vpcFilter = getSearchParam(searchParams, "vpc");
  const [disassociateTarget, setDisassociateTarget] =
    useState<FloatingIpSummary | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<FloatingIpSummary | null>(null);

  useFetcherResult(fetcher, (data) => {
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

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

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

        <ResourceTable
          isEmpty={filtered.length === 0}
          emptyMessage="No floating IPs. Associate a public address from an ipPools Multus network to a private VPC VM."
          headers={[
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
          {filtered.map((f) => (
            <Table.Tr key={`${f.cluster}/${f.namespace}/${f.vpcName}/${f.id}`}>
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
          ))}
        </ResourceTable>
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
    </Stack>
  );
}
