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
import { IconArrowLeft, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/load-balancers.$cluster.$namespace.$name";
import {
  ConfirmDeleteModal,
  DetailField,
  DetailSection,
  ResourceIdentity,
  ResourceLink,
  ResourceTable,
  StatusBadge,
  Table,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  formatAge,
  formatDateTime,
  loadBalancerPath,
  loadBalancersListPath,
  vmPath,
} from "~/lib/format";
import {
  deleteLoadBalancer,
  getLoadBalancer,
} from "~/backends/backends.server";
import type { BackendMembership } from "~/lib/types";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Load balancer"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const lb = await getLoadBalancer(cluster, namespace, name);
  return { lb };
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
    await deleteLoadBalancer(cluster, namespace, name);
    return redirect("/load-balancers");
  } catch (err) {
    return actionFailure("loadbalancer.delete", err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

function membershipModeLabel(
  membership: BackendMembership | { mode: "unknown" },
): string {
  switch (membership.mode) {
    case "single-vm":
      return "Single VM";
    case "labels":
      return "Label selector";
    case "group":
      return "VM group";
    case "unknown":
      return "Unknown";
    default:
      return (membership as { mode: string }).mode;
  }
}

function formatSelector(selector: Record<string, string>): string {
  return Object.entries(selector)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export default function LoadBalancerDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const { lb } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const selectorText = formatSelector(lb.selector);
  const membership = lb.membership;

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    } else if (data.ok) {
      notifyActionSuccess("Done", "Load balancer deleted");
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/load-balancers" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Load Balancers
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {lb.name}
            </Title>
            <Badge variant="light" color="teal">
              LoadBalancer
            </Badge>
            {lb.externalAddress ? (
              <Badge variant="light" color="green">
                {lb.externalAddress}
              </Badge>
            ) : (
              <Badge variant="light" color="yellow">
                VIP pending
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            items={[
              {
                label: lb.cluster,
                to: loadBalancersListPath({ cluster: lb.cluster }),
              },
              {
                label: lb.namespace,
                to: loadBalancersListPath({
                  cluster: lb.cluster,
                  namespace: lb.namespace,
                }),
              },
              { label: lb.name, to: loadBalancerPath(lb) },
            ]}
          />
        </div>
        <Button
          color="red"
          variant="light"
          leftSection={<IconTrash size={16} />}
          onClick={() => setDeleteOpen(true)}
          loading={busy}
        >
          Delete
        </Button>
      </Group>

      {!lb.externalAddress && (
        <Alert color="yellow" variant="light" title="External address pending">
          The Service is type LoadBalancer but no VIP is in{" "}
          <code>status.loadBalancer</code> yet. Ensure MetalLB (or another
          LoadBalancer controller) is installed and has free IPs.
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField label="Age" value={formatAge(lb.age)} />
            <DetailField label="Created" value={formatDateTime(lb.age)} />
            <DetailField
              label="Cluster"
              value={
                <ResourceLink
                  to={loadBalancersListPath({ cluster: lb.cluster })}
                  dimmed
                >
                  {lb.cluster}
                </ResourceLink>
              }
            />
            <DetailField
              label="Namespace"
              value={
                <ResourceLink
                  to={loadBalancersListPath({
                    cluster: lb.cluster,
                    namespace: lb.namespace,
                  })}
                  dimmed
                >
                  {lb.namespace}
                </ResourceLink>
              }
            />
            <DetailField
              label="External address"
              value={lb.externalAddress ?? "Pending"}
            />
            <DetailField
              label="Endpoints"
              value={
                lb.endpointsTotal != null
                  ? `${lb.endpointsReady ?? 0}/${lb.endpointsTotal} ready`
                  : undefined
              }
            />
          </SimpleGrid>
        </DetailSection>

        <DetailSection title="Backend">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField
              label="Membership"
              value={
                <Badge size="sm" variant="light" color="gray">
                  {membershipModeLabel(membership)}
                </Badge>
              }
            />
            <DetailField label="Service type" value={lb.serviceType} />

            {membership.mode === "single-vm" && (
              <DetailField
                label="Target VM"
                value={
                  membership.vmName ? (
                    <ResourceLink
                      to={vmPath({
                        cluster: lb.cluster,
                        namespace: lb.namespace,
                        name: membership.vmName,
                      })}
                    >
                      {membership.vmName}
                    </ResourceLink>
                  ) : (
                    "—"
                  )
                }
              />
            )}

            {membership.mode === "group" && (
              <DetailField label="Group id" value={membership.groupId} />
            )}

            {membership.mode === "labels" && (
              <DetailField
                label="Match labels"
                value={
                  <Code style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                    {formatSelector(membership.matchLabels) || "—"}
                  </Code>
                }
              />
            )}

            <DetailField
              label="Selector"
              value={
                selectorText ? (
                  <Code style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                    {selectorText}
                  </Code>
                ) : (
                  <Text size="sm" c="dimmed">
                    (none)
                  </Text>
                )
              }
            />
          </SimpleGrid>
        </DetailSection>
      </SimpleGrid>

      <DetailSection
        title={`Matched VMs${lb.matchedVms.length ? ` (${lb.matchedVms.length})` : ""}`}
      >
        {lb.matchedVms.length === 0 ? (
          <Text size="sm" c="dimmed">
            No VMs match the Service selector. Group members may need a restart
            for virt-launcher pods to pick up labels.
          </Text>
        ) : (
          <ResourceTable
            headers={["Name", "Status", "Network"]}
            isEmpty={false}
          >
            {lb.matchedVms.map((vm) => (
              <Table.Tr key={vm.name}>
                <Table.Td>
                  <ResourceLink
                    to={vmPath({
                      cluster: lb.cluster,
                      namespace: lb.namespace,
                      name: vm.name,
                    })}
                  >
                    {vm.name}
                  </ResourceLink>
                </Table.Td>
                <Table.Td>
                  <StatusBadge status={vm.status} />
                </Table.Td>
                <Table.Td>
                  {vm.podNetwork ? (
                    <Text size="sm" c="dimmed">
                      Pod
                    </Text>
                  ) : (
                    <Badge size="sm" variant="light" color="orange">
                      Multus only
                    </Badge>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </ResourceTable>
        )}
      </DetailSection>

      <DetailSection title="Ports">
        {lb.ports.length === 0 ? (
          <Text size="sm" c="dimmed">
            No ports
          </Text>
        ) : (
          <ResourceTable
            headers={["Name", "Port", "Target", "Protocol"]}
            isEmpty={false}
          >
            {lb.ports.map((p, i) => (
              <Table.Tr key={`${p.name ?? "port"}-${p.port}-${i}`}>
                <Table.Td>
                  <Text size="sm">{p.name ?? "—"}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{p.port}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{p.targetPort}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {p.protocol ?? "TCP"}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </ResourceTable>
        )}
      </DetailSection>

      <ConfirmDeleteModal
        opened={deleteOpen}
        resourceName={lb.name}
        identity={`${lb.cluster}/${lb.namespace}/${lb.name}`}
        title="Delete load balancer"
        confirmLabel="Delete"
        warning="Deletes the LoadBalancer Service. Group membership labels are cleared. VirtualMachines are not deleted."
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
