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
  routerPath,
  vmPath,
  vpcEditPath,
  vpcRouterCreatePath,
  vpcsListPath,
} from "~/lib/format";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import type { FloatingIpAssociation } from "~/lib/types";
import {
  deleteVpc,
  disassociateFloatingIp,
  getVpc,
  getVpcYaml,
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

  return { vpc, yaml };
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
  const { vpc, yaml } = loaderData;
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
            {vpc.router && (
              <Badge variant="light" color="violet">
                Router
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
                  {vm.isRouter ? (
                    <Badge size="sm" variant="light" color="violet">
                      Router
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
