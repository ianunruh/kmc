import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconPencil,
  IconPlus,
  IconRouter,
  IconTrash,
  IconWorldWww,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/vpcs.$cluster.$namespace.$name";
import {
  ConfirmActionModal,
  ConfirmDeleteModal,
  DetailField,
  DetailSection,
  ResourceIdentity,
  ResourceLink,
  ResourceTable,
  StatusBadge,
  Table,
  YamlPanel,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  floatingIpCreatePath,
  floatingIpsListPath,
  formatAge,
  formatDateTime,
  vmPath,
  vpcEditPath,
  vpcNatGatewayPath,
  vpcsListPath,
} from "~/lib/format";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import type { FloatingIpAssociation } from "~/lib/types";
import {
  defaultGatewayAddress,
  deleteVpc,
  disassociateFloatingIp,
  getVpc,
  getVpcYaml,
  listPublicEgressNetworks,
  releaseFloatingIp,
} from "~/vpcs/vpcs.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "VPC"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const [vpc, yaml] = await Promise.all([
    getVpc(cluster, namespace, name),
    getVpcYaml(cluster, namespace, name),
  ]);

  const publicNetworks = listPublicEgressNetworks(cluster, {
    excludeMultus: name,
  });
  const suggestedGateway =
    vpc.gateway?.trim() || (vpc.cidr ? defaultGatewayAddress(vpc.cidr) : undefined);

  return {
    vpc,
    yaml,
    publicNetworkCount: publicNetworks.length,
    suggestedGateway,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing path params" };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "delete") {
    try {
      await deleteVpc(cluster, namespace, name);
      return redirect("/vpcs");
    } catch (err) {
      return actionFailure("vpc.delete", err, {
        intent,
        cluster,
        namespace,
        name,
      });
    }
  }
  if (intent === "disassociate" || intent === "release") {
    const idOrPublic = String(form.get("idOrPublic") ?? "").trim();
    if (!idOrPublic) {
      return { ok: false, error: "Missing floating IP id", intent };
    }
    try {
      if (intent === "disassociate") {
        await disassociateFloatingIp({
          cluster,
          namespace,
          vpcName: name,
          idOrPublic,
        });
      } else {
        await releaseFloatingIp({
          cluster,
          namespace,
          vpcName: name,
          idOrPublic,
        });
      }
      return { ok: true, intent };
    } catch (err) {
      return actionFailure(`floatingIp.${intent}`, err, {
        intent,
        cluster,
        namespace,
        name,
        idOrPublic,
      });
    }
  }
  return { ok: false, error: `Unknown intent: ${intent}`, intent };
}

export default function VpcDetailPage({ loaderData }: Route.ComponentProps) {
  const { vpc, yaml, publicNetworkCount, suggestedGateway } = loaderData;
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string;
    intent?: string;
  }>();
  const { refreshNow } = useRefresh();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [disassociateTarget, setDisassociateTarget] =
    useState<FloatingIpAssociation | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<FloatingIpAssociation | null>(
    null,
  );
  const busy = fetcher.state !== "idle";
  const hasAttachments = vpc.attachedCount > 0;
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
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/vpcs" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              VPCs
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {vpc.name}
            </Title>
            <Badge variant="light" color="accent" ff="monospace">
              VLAN {vpc.vlan}
            </Badge>
            {vpc.cidr ? (
              <Badge variant="light" color="gray">
                IPAM
              </Badge>
            ) : (
              <Badge variant="light" color="gray">
                L2 only
              </Badge>
            )}
            {vpc.natGateway && (
              <Badge variant="light" color="teal">
                NAT gateway
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            items={[
              { label: vpc.cluster, to: vpcsListPath({ cluster: vpc.cluster }) },
              {
                label: vpc.namespace,
                to: vpcsListPath({
                  cluster: vpc.cluster,
                  namespace: vpc.namespace,
                }),
              },
            ]}
          />
        </div>
        <Group gap="sm">
          <Button
            component={Link}
            to={vpcEditPath(vpc)}
            variant="default"
            leftSection={<IconPencil size={16} />}
          >
            Edit
          </Button>
          <Button
            color="red"
            variant="light"
            leftSection={<IconTrash size={16} />}
            disabled={busy || hasAttachments}
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </Button>
        </Group>
      </Group>

      {hasAttachments && (
        <Alert color="yellow" variant="light" title="VMs attached">
          Delete is blocked while {vpc.attachedCount} VM(s) still use this Multus network.
          Stop and delete or re-attach those VMs first.
        </Alert>
      )}

      {vpc.description && (
        <Text size="sm" c="dimmed">
          {vpc.description}
        </Text>
      )}

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

      <DetailSection title="NAT gateway">
        {vpc.natGateway ? (
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <DetailField
              label="VM"
              value={
                <ResourceLink to={vmPath(vpc.natGateway)}>
                  {vpc.natGateway.name}
                </ResourceLink>
              }
            />
            <DetailField
              label="Private IP"
              value={
                vpc.natGateway.privateIpv4 ? (
                  <Code>{vpc.natGateway.privateIpv4}</Code>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Public IP"
              value={
                vpc.natGateway.publicIpv4 ? (
                  <Code>{vpc.natGateway.publicIpv4}</Code>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Egress network"
              value={
                vpc.natGateway.publicNetwork ? (
                  <Code>{vpc.natGateway.publicNetwork}</Code>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Policy ConfigMap"
              value={
                vpc.natGateway.policyConfigMap ? (
                  <Code>{vpc.natGateway.policyConfigMap}</Code>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Agent"
              value={
                vpc.natGateway.agentStatus ? (
                  <Group gap="xs">
                    <StatusBadge status={vpc.natGateway.agentStatus} />
                    {vpc.natGateway.agentObservedGeneration ? (
                      <Text size="xs" c="dimmed">
                        gen {vpc.natGateway.agentObservedGeneration}
                      </Text>
                    ) : null}
                    {vpc.natGateway.agentVersion ? (
                      <Text size="xs" c="dimmed" ff="monospace">
                        {vpc.natGateway.agentVersion}
                      </Text>
                    ) : null}
                  </Group>
                ) : (
                  "—"
                )
              }
            />
            {vpc.natGateway.agentLastError ? (
              <DetailField
                label="Agent error"
                value={
                  <Text size="sm" c="red">
                    {vpc.natGateway.agentLastError}
                  </Text>
                }
              />
            ) : null}
            {vpc.natGateway.agentHeartbeatAt ? (
              <DetailField
                label="Agent heartbeat"
                value={
                  <Text
                    size="sm"
                    c={vpc.natGateway.agentStatus === "Stale" ? "orange" : "dimmed"}
                  >
                    {vpc.natGateway.agentHeartbeatAt}
                  </Text>
                }
              />
            ) : null}
            {vpc.natGateway.agentAppliedAt ? (
              <DetailField
                label="Agent applied"
                value={
                  <Text size="sm" c="dimmed">
                    {vpc.natGateway.agentAppliedAt}
                  </Text>
                }
              />
            ) : null}
          </SimpleGrid>
        ) : !vpc.cidr ? (
          <Text size="sm" c="dimmed">
            Enable private IPAM (CIDR) on this VPC to add a NAT gateway for egress.
          </Text>
        ) : publicNetworkCount === 0 ? (
          <Text size="sm" c="dimmed">
            No public Multus networks with <Code>ipPools</Code> are configured on this
            cluster. Add an egress pool (e.g. <Code>external</Code>) in{" "}
            <Code>clusters.yaml</Code>.
          </Text>
        ) : (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              Triple-homed Ubuntu VM: private NIC owns the VPC gateway (
              <Code>{suggestedGateway ?? "—"}</Code>
              ), public Multus does SNAT/floating IPs, pod network runs the policy agent
              (requires <Code>network.podCIDR</Code> / <Code>serviceCIDR</Code> in{" "}
              <Code>clusters.yaml</Code>).
            </Text>
            <Group>
              <Button
                component={Link}
                to={vpcNatGatewayPath(vpc)}
                size="xs"
                variant="light"
                color="teal"
                leftSection={<IconRouter size={14} />}
              >
                Add NAT gateway
              </Button>
            </Group>
          </Stack>
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
            {vpc.natGateway ? (
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
                title="Create a NAT gateway before associating floating IPs"
              >
                Associate
              </Button>
            )}
          </Group>
        }
      >
        {!vpc.cidr ? (
          <Text size="sm" c="dimmed">
            Enable private IPAM (CIDR) and a NAT gateway to associate floating public
            addresses with private VMs.
          </Text>
        ) : vpc.floatingIps.length === 0 ? (
          <Text size="sm" c="dimmed">
            {vpc.natGateway
              ? "None yet. Associate a public Multus address to a private VM; the in-guest agent applies DNAT/SNAT from the policy ConfigMap."
              : "None. Associations are stored on the NAT policy ConfigMap and survive gateway delete — recreate a NAT gateway to apply them, or associate after adding one."}
          </Text>
        ) : (
          <Stack gap="sm">
            {!vpc.natGateway && (
              <Alert color="yellow" variant="light" title="No NAT gateway">
                These mappings are reserved in policy but not applied until a NAT
                gateway is running. Recreate the gateway to restore DNAT/SNAT; Associate
                stays disabled until then.
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
                      ) : vpc.natGateway ? (
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

      <DetailSection title={`Attached VMs (${vpc.attachedCount})`}>
        {vpc.attachedVms.length === 0 ? (
          <Text size="sm" c="dimmed">
            No VMs reference this Multus network.
          </Text>
        ) : (
          <ResourceTable isEmpty={false} headers={["Name", "Namespace", "IPv4", "Role"]}>
            {vpc.attachedVms.map((vm) => (
              <Table.Tr key={`${vm.namespace}/${vm.name}`}>
                <Table.Td>
                  <ResourceLink to={vmPath(vm)}>{vm.name}</ResourceLink>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {vm.namespace}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text
                    size="sm"
                    ff="monospace"
                    c={vm.allocatedIpv4 ? undefined : "dimmed"}
                  >
                    {vm.allocatedIpv4 ?? "—"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {vm.isNatGateway ? (
                    <Badge size="sm" variant="light" color="teal">
                      NAT gateway
                    </Badge>
                  ) : (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </ResourceTable>
        )}
      </DetailSection>

      <YamlPanel yaml={yaml} />

      <ConfirmDeleteModal
        opened={deleteOpen}
        resourceName={vpc.name}
        identity={`${vpc.cluster}/${vpc.namespace}/${vpc.name}`}
        title="Delete VPC"
        confirmLabel="Delete VPC"
        warning="Deletes the Multus NetworkAttachmentDefinition and frees the VLAN for reallocation."
        loading={busy}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit({ intent: "delete" }, { method: "post" });
          setDeleteOpen(false);
        }}
      />

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
            { method: "post" },
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
