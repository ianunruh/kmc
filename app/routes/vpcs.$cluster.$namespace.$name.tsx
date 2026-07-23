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
import { IconArrowLeft, IconPencil, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/vpcs.$cluster.$namespace.$name";
import {
  ConfirmDeleteModal,
  DetailField,
  DetailSection,
  ResourceIdentity,
  ResourceLink,
  ResourceTable,
  Table,
  YamlPanel,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  formatAge,
  formatDateTime,
  vmPath,
  vpcEditPath,
  vpcsListPath,
} from "~/lib/format";
import {
  deleteVpc,
  getVpc,
  getVpcYaml,
} from "~/vpcs/vpcs.server";
import { useFetcherResult } from "~/lib/use-fetcher-result";

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
  if (intent !== "delete") {
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  }
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

export default function VpcDetailPage({ loaderData }: Route.ComponentProps) {
  const { vpc, yaml } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const hasAttachments = vpc.attachedCount > 0;

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    } else if (data.ok) {
      notifyActionSuccess("Done", "VPC deleted");
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
          Delete is blocked while {vpc.attachedCount} VM(s) still use this Multus
          network. Stop and delete or re-attach those VMs first.
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
                  vpc.dns && vpc.dns.length > 0 ? (
                    <Code>{vpc.dns.join(", ")}</Code>
                  ) : (
                    "—"
                  )
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
              Pure L2 — no private CIDR. Guests are not auto-configured by kmc.
              Enable IPAM when creating a VPC, or configure guest networking
              manually.
            </Text>
          )}
        </DetailSection>
      </SimpleGrid>

      <DetailSection title={`Attached VMs (${vpc.attachedCount})`}>
        {vpc.attachedVms.length === 0 ? (
          <Text size="sm" c="dimmed">
            No VMs reference this Multus network.
          </Text>
        ) : (
          <ResourceTable
            isEmpty={false}
            headers={["Name", "Namespace"]}
          >
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
    </Stack>
  );
}
