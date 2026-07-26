import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import {
  IconArrowsRightLeft,
  IconLink,
  IconPlus,
  IconRouter,
  IconWorldWww,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, useFetcher, useRouteLoaderData } from "react-router";
import type { loader as detailLoader } from "./vpcs.$cluster.$namespace.$name";
import {
  ConfirmActionModal,
  DetailField,
  DetailSection,
  ResourceLink,
  ResourceTable,
  StatusBadge,
  Table,
} from "~/ui";
import {
  floatingIpCreatePath,
  floatingIpsListPath,
  formatAge,
  formatDateTime,
  portForwardCreatePath,
  portForwardsListPath,
  routerPath,
  vmPath,
  vpcPath,
  vpcRouterCreatePath,
  vpcsListPath,
} from "~/lib/format";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import type {
  FloatingIpAssociation,
  PortForwardAssociation,
} from "~/lib/types";

const LAYOUT_ID = "routes/vpcs.$cluster.$namespace.$name";

export default function VpcOverviewTab() {
  const { vpc, attachableRouters } = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string;
    intent?: string;
    restarted?: boolean;
  }>();
  const { refreshNow } = useRefresh();
  const [disassociateTarget, setDisassociateTarget] =
    useState<FloatingIpAssociation | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<FloatingIpAssociation | null>(
    null,
  );
  const [deletePfTarget, setDeletePfTarget] =
    useState<PortForwardAssociation | null>(null);
  const [attachRouterName, setAttachRouterName] = useState(
    attachableRouters[0]?.name ?? "",
  );
  const busy = fetcher.state !== "idle";
  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      const title =
        data.intent === "disassociate"
          ? "Disassociate failed"
          : data.intent === "release"
            ? "Release failed"
            : data.intent === "delete-port-forward"
              ? "Delete port forward failed"
              : data.intent === "attach-router"
                ? "Attach router failed"
                : "Delete failed";
      notifyActionError(title, data.error);
    } else if (data.ok) {
      if (data.intent === "disassociate") {
        notifyActionSuccess(
          "Done",
          "Floating IP disassociated — public address is held (not released)",
        );
        refreshNow();
      } else if (data.intent === "release") {
        notifyActionSuccess(
          "Done",
          "Floating IP released — public address returned to the pool",
        );
        refreshNow();
      } else if (data.intent === "delete-port-forward") {
        notifyActionSuccess("Done", "Port forward deleted");
        refreshNow();
      } else if (data.intent === "attach-router") {
        notifyActionSuccess(
          "Done",
          data.restarted
            ? "Router attached — appliance restarted so the Multus NIC could land"
            : "Router attached",
        );
        setAttachRouterName("");
        refreshNow();
      } else {
        notifyActionSuccess("Done", "VPC deleted");
      }
    }
  });

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField label="Age" value={formatAge(vpc.age)} />
            <DetailField label="Created" value={formatDateTime(vpc.age)} />
            <DetailField
              label="Cluster"
              value={
                <ResourceLink to={vpcsListPath({ cluster: vpc.cluster })} dimmed>
                  {vpc.cluster}
                </ResourceLink>
              }
            />
            <DetailField
              label="Namespace"
              value={
                <ResourceLink
                  to={vpcsListPath({
                    cluster: vpc.cluster,
                    namespace: vpc.namespace,
                  })}
                  dimmed
                >
                  {vpc.namespace}
                </ResourceLink>
              }
            />
            <DetailField label="VLAN" value={<Code>{vpc.vlan}</Code>} />
            <DetailField
              label="VLAN pool"
              value={vpc.vlanPoolId ? <Code>{vpc.vlanPoolId}</Code> : "—"}
            />
            <DetailField
              label="Bridge"
              value={vpc.bridge ? <Code>{vpc.bridge}</Code> : "—"}
            />
            <DetailField
              label="Owner"
              value={vpc.owner ? <Code>{vpc.owner}</Code> : "—"}
            />
          </SimpleGrid>
        </DetailSection>

        <DetailSection title="IPAM">
          {vpc.cidr ? (
            <SimpleGrid cols={2} spacing="sm">
              <DetailField label="CIDR" value={<Code>{vpc.cidr}</Code>} />
              <DetailField
                label="Gateway"
                value={
                  vpc.gateway ? (
                    <Code>{vpc.gateway}</Code>
                  ) : (
                    <Text size="sm" c="dimmed">
                      none (no default route)
                    </Text>
                  )
                }
              />
              <DetailField
                label="DNS"
                value={
                  vpc.dns && vpc.dns.length > 0 ? <Code>{vpc.dns.join(", ")}</Code> : "—"
                }
              />
              {vpc.ipPool && (
                <>
                  <DetailField
                    label="Addresses free"
                    value={`${vpc.ipPool.free} / ${vpc.ipPool.total}`}
                  />
                </>
              )}
            </SimpleGrid>
          ) : (
            <Text size="sm" c="dimmed">
              Pure L2 — no private CIDR. Guests are not auto-configured by kmc. Enable
              IPAM when creating a VPC, or configure guest networking manually.
            </Text>
          )}
        </DetailSection>
      </SimpleGrid>

      <DetailSection title="Router">
        {vpc.router ? (
          <Stack gap="sm">
            <SimpleGrid cols={2} spacing="sm">
              <DetailField
                label="Name"
                value={
                  <ResourceLink to={routerPath(vpc.router)}>
                    {vpc.router.name}
                  </ResourceLink>
                }
              />
              <DetailField
                label="Agent"
                value={
                  vpc.router.agentStatus ? (
                    <StatusBadge status={vpc.router.agentStatus} />
                  ) : (
                    "—"
                  )
                }
              />
              <DetailField
                label="VPCs on router"
                value={
                  <Text size="sm" ff="monospace">
                    {vpc.router.vpcNames.join(", ") || "—"}
                  </Text>
                }
              />
              <DetailField
                label="External GW"
                value={vpc.router.hasExternal ? "Yes" : "No"}
              />
            </SimpleGrid>
            <Text size="xs" c="dimmed">
              Guests on this VPC use DHCP from the router (gateway + DNS). Static
              cloud-init IPs are not used for the private NIC when a router is attached.
            </Text>
          </Stack>
        ) : vpc.cidr ? (
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              No shared router. Attach an existing router in this namespace or create a
              new one for DHCP/DNS and optional external SNAT / floating IPs.
            </Text>
            <Group>
              <Button
                component={Link}
                to={vpcRouterCreatePath(vpc)}
                leftSection={<IconRouter size={16} />}
                variant="light"
                color="violet"
              >
                Create router
              </Button>
            </Group>
            {attachableRouters.length > 0 && (
              <Group align="flex-end" gap="sm" wrap="wrap">
                <Select
                  label="Existing router"
                  placeholder="Select router"
                  data={attachableRouters.map((r) => ({
                    value: r.name,
                    label: `${r.name}${
                      r.vpcNames.length
                        ? ` · ${r.vpcNames.join(", ")}`
                        : ""
                    }${r.hasExternal ? " · external" : ""}`,
                  }))}
                  value={attachRouterName || null}
                  onChange={(v) => setAttachRouterName(v ?? "")}
                  searchable
                  clearable
                  disabled={busy}
                  style={{ minWidth: 240, flex: 1 }}
                />
                <Button
                  size="sm"
                  leftSection={<IconLink size={16} />}
                  loading={
                    busy && fetcher.formData?.get("intent") === "attach-router"
                  }
                  disabled={busy || !attachRouterName}
                  onClick={() => {
                    const fd = new FormData();
                    fd.set("intent", "attach-router");
                    fd.set("routerName", attachRouterName);
                    fetcher.submit(fd, {
                      method: "post",
                      action: vpcPath(vpc),
                    });
                  }}
                >
                  Attach router
                </Button>
              </Group>
            )}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            Enable private IPAM (CIDR) to attach a router for DHCP/DNS.
          </Text>
        )}
      </DetailSection>

      <DetailSection
        title={`Floating IPs (${vpc.floatingIps.length})`}
        actions={
          <Group gap="xs">
            <Button
              component={Link}
              to={floatingIpsListPath({
                cluster: vpc.cluster,
                namespace: vpc.namespace,
                vpc: vpc.name,
              })}
              size="xs"
              variant="subtle"
              leftSection={<IconWorldWww size={14} />}
            >
              All floating IPs
            </Button>
            {vpc.router?.hasExternal ? (
              <Group gap="xs">
                <Button
                  component={Link}
                  to={floatingIpCreatePath({
                    cluster: vpc.cluster,
                    namespace: vpc.namespace,
                    vpc: vpc.name,
                    mode: "reserve",
                  })}
                  size="xs"
                  variant="default"
                  leftSection={<IconPlus size={14} />}
                >
                  Reserve
                </Button>
                <Button
                  component={Link}
                  to={floatingIpCreatePath({
                    cluster: vpc.cluster,
                    namespace: vpc.namespace,
                    vpc: vpc.name,
                    mode: "associate",
                  })}
                  size="xs"
                  variant="light"
                  color="teal"
                  leftSection={<IconPlus size={14} />}
                >
                  Associate
                </Button>
              </Group>
            ) : (
              <Button
                size="xs"
                variant="light"
                color="teal"
                leftSection={<IconPlus size={14} />}
                disabled
                title="Enable router external gateway first"
              >
                Associate
              </Button>
            )}
          </Group>
        }
      >
        {!vpc.cidr ? (
          <Text size="sm" c="dimmed">
            Enable private IPAM (CIDR) and a router external gateway to
            associate floating public addresses with private VMs.
          </Text>
        ) : vpc.floatingIps.length === 0 ? (
          <Text size="sm" c="dimmed">
            {vpc.router?.hasExternal
              ? "None yet. Associate a public Multus address to a private VM; the agent applies DNAT/SNAT from the policy ConfigMap."
              : "None. Enable an external gateway on the shared router first."}
          </Text>
        ) : (
          <Stack gap="sm">
            {!vpc.router?.hasExternal && (
              <Alert color="yellow" variant="light" title="No external gateway">
                These mappings are reserved in policy but not applied until the router
                has an external gateway.
              </Alert>
            )}
            <ResourceTable
              isEmpty={false}
              headers={["Public", "State", "Private", "Target VM", ""]}
            >
              {vpc.floatingIps.map((f) => (
                <Table.Tr key={f.id}>
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
                    {f.private ? (
                      <Code>{f.private}</Code>
                    ) : (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {f.targetVm ? (
                      <ResourceLink
                        to={vmPath({
                          cluster: vpc.cluster,
                          namespace: vpc.namespace,
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
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      {f.state === "associated" ? (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="orange"
                          disabled={busy}
                          onClick={() => setDisassociateTarget(f)}
                        >
                          Disassociate
                        </Button>
                      ) : vpc.router?.hasExternal ? (
                        <Button
                          component={Link}
                          to={floatingIpCreatePath({
                            cluster: vpc.cluster,
                            namespace: vpc.namespace,
                            vpc: vpc.name,
                            publicIpv4: f.public,
                          })}
                          size="compact-xs"
                          variant="subtle"
                          color="teal"
                        >
                          Associate
                        </Button>
                      ) : null}
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        disabled={busy}
                        onClick={() => setReleaseTarget(f)}
                      >
                        Release
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </ResourceTable>
          </Stack>
        )}
      </DetailSection>

      <DetailSection
        title={`Port Forwards (${vpc.portForwards.length})`}
        actions={
          <Group gap="xs">
            <Button
              component={Link}
              to={portForwardsListPath({
                cluster: vpc.cluster,
                namespace: vpc.namespace,
                vpc: vpc.name,
              })}
              size="xs"
              variant="subtle"
              leftSection={<IconArrowsRightLeft size={14} />}
            >
              All port forwards
            </Button>
            {vpc.router?.hasExternal ? (
              <Button
                component={Link}
                to={portForwardCreatePath({
                  cluster: vpc.cluster,
                  namespace: vpc.namespace,
                  vpc: vpc.name,
                })}
                size="xs"
                variant="light"
                color="teal"
                leftSection={<IconPlus size={14} />}
              >
                Create
              </Button>
            ) : (
              <Button
                size="xs"
                variant="light"
                color="teal"
                leftSection={<IconPlus size={14} />}
                disabled
                title="Enable router external gateway first"
              >
                Create
              </Button>
            )}
          </Group>
        }
      >
        {!vpc.cidr ? (
          <Text size="sm" c="dimmed">
            Enable private IPAM (CIDR) and a router external gateway to map public
            ports to private VMs.
          </Text>
        ) : vpc.portForwards.length === 0 ? (
          <Text size="sm" c="dimmed">
            {vpc.router?.hasExternal
              ? "None yet. Map a public port to a private VM without a full floating IP."
              : "None. Enable an external gateway on the shared router first."}
          </Text>
        ) : (
          <ResourceTable
            isEmpty={false}
            headers={["Public", "Protocol", "Private", "Target VM", ""]}
          >
            {vpc.portForwards.map((pf) => (
              <Table.Tr key={pf.id}>
                <Table.Td>
                  <Code>
                    {pf.public}:{pf.publicPort}
                  </Code>
                </Table.Td>
                <Table.Td>
                  <Badge size="sm" variant="light" color="blue">
                    {pf.protocol.toUpperCase()}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Code>
                    {pf.private}:{pf.privatePort}
                  </Code>
                </Table.Td>
                <Table.Td>
                  {pf.targetVm ? (
                    <ResourceLink
                      to={vmPath({
                        cluster: vpc.cluster,
                        namespace: vpc.namespace,
                        name: pf.targetVm,
                      })}
                    >
                      {pf.targetVm}
                    </ResourceLink>
                  ) : (
                    "—"
                  )}
                </Table.Td>
                <Table.Td>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    disabled={busy}
                    onClick={() => setDeletePfTarget(pf)}
                  >
                    Delete
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </ResourceTable>
        )}
      </DetailSection>

      <ConfirmActionModal
        opened={disassociateTarget != null}
        onClose={() => setDisassociateTarget(null)}
        title="Disassociate floating IP"
        confirmLabel="Disassociate"
        confirmColor="orange"
        loading={busy}
        onConfirm={() => {
          if (!disassociateTarget) return;
          // Layout action shares this URL; ".." skips the layout, "." uses ?index (405).
          fetcher.submit(
            {
              intent: "disassociate",
              idOrPublic: disassociateTarget.id,
            },
            { method: "post", action: vpcPath(vpc) },
          );
          setDisassociateTarget(null);
        }}
        message={
          disassociateTarget ? (
            <>
              Unmap{" "}
              <Code>
                {disassociateTarget.public} → {disassociateTarget.private}
              </Code>
              ? The public address stays reserved (held) until you release it. The NAT
              agent will drop DNAT/SNAT on its next reconcile.
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
              idOrPublic: releaseTarget.id,
            },
            { method: "post", action: vpcPath(vpc) },
          );
          setReleaseTarget(null);
        }}
        message={
          releaseTarget ? (
            <>
              Return <Code>{releaseTarget.public}</Code> to the public IP pool?
              {releaseTarget.private ? (
                <>
                  {" "}
                  This also drops the mapping to <Code>{releaseTarget.private}</Code>.
                </>
              ) : null}
            </>
          ) : (
            ""
          )
        }
      />

      <ConfirmActionModal
        opened={deletePfTarget != null}
        onClose={() => setDeletePfTarget(null)}
        title="Delete port forward"
        confirmLabel="Delete"
        confirmColor="red"
        loading={busy}
        onConfirm={() => {
          if (!deletePfTarget) return;
          fetcher.submit(
            {
              intent: "delete-port-forward",
              id: deletePfTarget.id,
            },
            { method: "post", action: vpcPath(vpc) },
          );
          setDeletePfTarget(null);
        }}
        message={
          deletePfTarget ? (
            <>
              Remove{" "}
              <Code>
                {deletePfTarget.protocol.toUpperCase()} {deletePfTarget.public}:
                {deletePfTarget.publicPort} → {deletePfTarget.private}:
                {deletePfTarget.privatePort}
              </Code>
              ?
            </>
          ) : (
            ""
          )
        }
      />
    </Stack>
  );
}
