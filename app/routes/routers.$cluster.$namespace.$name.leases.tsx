import { Code, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import { DetailSection, ResourceLink, ResourceTable, Table } from "~/ui";
import { vmPath, vpcPath } from "~/lib/format";
import type { loader as detailLoader } from "./routers.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/routers.$cluster.$namespace.$name";

export default function RouterLeasesTab() {
  const { router } = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;

  return (
    <DetailSection title={`DHCP leases (${router.leases.length})`}>
      {router.leases.length === 0 ? (
        <Text size="sm" c="dimmed">
          No leases yet. Launch a VM attached to a VPC on this router to register a
          static lease (guest uses DHCP).
        </Text>
      ) : (
        <ResourceTable
          isEmpty={false}
          headers={["Hostname", "VPC", "IP", "MAC", "VM"]}
        >
          {router.leases.map((L) => (
            <Table.Tr key={`${L.vpc}/${L.mac}/${L.ip}`}>
              <Table.Td>
                <Text size="sm" ff="monospace">
                  {L.hostname}
                </Text>
              </Table.Td>
              <Table.Td>
                <ResourceLink
                  to={vpcPath({
                    cluster: router.cluster,
                    namespace: router.namespace,
                    name: L.vpc,
                  })}
                >
                  {L.vpc}
                </ResourceLink>
              </Table.Td>
              <Table.Td>
                <Code>{L.ip}</Code>
              </Table.Td>
              <Table.Td>
                <Text size="xs" ff="monospace" c="dimmed">
                  {L.mac}
                </Text>
              </Table.Td>
              <Table.Td>
                {L.vm ? (
                  <ResourceLink
                    to={vmPath({
                      cluster: router.cluster,
                      namespace: router.namespace,
                      name: L.vm,
                    })}
                  >
                    {L.vm}
                  </ResourceLink>
                ) : (
                  "—"
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </ResourceTable>
      )}
    </DetailSection>
  );
}
