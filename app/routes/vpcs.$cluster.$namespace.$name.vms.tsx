import { Badge, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import { DetailSection, ResourceLink, ResourceTable, Table } from "~/ui";
import { vmPath } from "~/lib/format";
import type { loader as detailLoader } from "./vpcs.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/vpcs.$cluster.$namespace.$name";

export default function VpcAttachedVmsTab() {
  const { vpc } = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;

  return (
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
  );
}
