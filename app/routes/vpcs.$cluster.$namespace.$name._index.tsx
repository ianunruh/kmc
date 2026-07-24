import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import {
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
  routerPath,
  vmPath,
  vpcRouterCreatePath,
  vpcsListPath,
} from "~/lib/format";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import type { FloatingIpAssociation } from "~/lib/types";

const LAYOUT_ID = "routes/vpcs.$cluster.$namespace.$name";

export default function VpcOverviewTab() {
  const { vpc } = useRouteLoaderData(LAYOUT_ID) as Awaited<ReturnType<typeof detailLoader>>;
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string;
    intent?: string;
  }>();
  const { refreshNow } = useRefresh();
  const [disassociateTarget, setDisassociateTarget] =
    useState<FloatingIpAssociation | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<FloatingIpAssociation | null>(
    null,
  );
  const busy = fetcher.state !== "idle";
  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      const title =
        data.intent === "disassociate"
          ? "Disassociate failed"
          : data.intent === "release"
            ? "Release failed"
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
              No shared router. Create one to provide DHCP/DNS and optional external SNAT
              / floating IPs.
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
              <Button
                component={Link}
                to={floatingIpCreatePath({
                  cluster: vpc.cluster,
                  namespace: vpc.namespace,
                  vpc: vpc.name,
                })}
                size="xs"
                variant="light"
                color="teal"
                leftSection={<IconPlus size={14} />}
              >
                Associate
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
              idOrPublic: disassociateTarget.id,
            },
            { method: "post", action: ".." },
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
            { method: "post", action: ".." },
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
    </Stack>
  );
}
