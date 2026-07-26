import { Badge, Code, SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import {
  DetailField,
  DetailSection,
  ResourceLink,
  ResourceTable,
  StatusBadge,
  Table,
} from "~/ui";
import {
  formatAge,
  formatDateTime,
  loadBalancersListPath,
  vmPath,
} from "~/lib/format";
import {
  formatLabelSelector,
  membershipModeLabel,
} from "~/backends/membership";
import type { loader as detailLoader } from "./load-balancers.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/load-balancers.$cluster.$namespace.$name";

export default function LoadBalancerOverviewTab() {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { lb } = data;
  const membership = lb.membership;
  const selectorText = formatLabelSelector(lb.selector);
  const matchedVms = lb.matchedVms;

  return (
    <Stack gap="md">
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
                    {formatLabelSelector(membership.matchLabels) || "—"}
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
        title={`Matched VMs${matchedVms.length ? ` (${matchedVms.length})` : ""}`}
      >
        {matchedVms.length === 0 ? (
          <Text size="sm" c="dimmed">
            No VMs match the Service selector. Group members may need a restart
            for virt-launcher pods to pick up labels.
          </Text>
        ) : (
          <ResourceTable
            headers={["Name", "Status", "Network"]}
            isEmpty={false}
          >
            {matchedVms.map((vm) => (
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
    </Stack>
  );
}
