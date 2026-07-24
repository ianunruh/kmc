import { Badge, Code, SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import {
  ClampedText,
  DetailField,
  DetailSection,
  ResourceLink,
  ResourceTable,
  Table,
} from "~/ui";
import { StatusBadge } from "~/ui/status-badge";
import {
  dataVolumesListPath,
  formatAge,
  formatDateTime,
  vmPath,
} from "~/lib/format";
import type { loader as detailLoader } from "./datavolumes.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/datavolumes.$cluster.$namespace.$name";

export default function DataVolumeOverviewTab() {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { dv } = data;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField
              label="Phase"
              value={
                <ResourceLink
                  to={dataVolumesListPath({
                    cluster: dv.cluster,
                    phase: dv.phase,
                  })}
                  underline="never"
                >
                  <StatusBadge status={dv.phase} />
                </ResourceLink>
              }
            />
            <DetailField label="Progress" value={dv.progress} />
            <DetailField label="Age" value={formatAge(dv.age)} />
            <DetailField label="Created" value={formatDateTime(dv.age)} />
            <DetailField
              label="Cluster"
              value={
                <ResourceLink to={dataVolumesListPath({ cluster: dv.cluster })} dimmed>
                  {dv.cluster}
                </ResourceLink>
              }
            />
            <DetailField
              label="Namespace"
              value={
                <ResourceLink
                  to={dataVolumesListPath({
                    cluster: dv.cluster,
                    namespace: dv.namespace,
                  })}
                  dimmed
                >
                  {dv.namespace}
                </ResourceLink>
              }
            />
            <DetailField label="Size" value={dv.size} />
            <DetailField label="Storage class" value={dv.storageClass} />
            <DetailField label="Volume mode" value={dv.volumeMode} />
            <DetailField label="Access modes" value={dv.accessModes?.join(", ")} />
            <DetailField label="Claim" value={dv.claimName} />
            <DetailField
              label="Owner"
              value={
                dv.ownerName ? (
                  dv.ownerKind === "VirtualMachine" ? (
                    <ResourceLink
                      to={vmPath({
                        cluster: dv.cluster,
                        namespace: dv.namespace,
                        name: dv.ownerName,
                      })}
                    >
                      {dv.ownerKind}/{dv.ownerName}
                    </ResourceLink>
                  ) : (
                    `${dv.ownerKind}/${dv.ownerName}`
                  )
                ) : undefined
              }
            />
            <DetailField
              label="Attached VM"
              value={
                dv.attachedVms && dv.attachedVms.length > 0 ? (
                  <Stack gap={4}>
                    {dv.attachedVms.map((vmName) => (
                      <ResourceLink
                        key={vmName}
                        to={vmPath({
                          cluster: dv.cluster,
                          namespace: dv.namespace,
                          name: vmName,
                        })}
                      >
                        {vmName}
                      </ResourceLink>
                    ))}
                  </Stack>
                ) : undefined
              }
            />
            {dv.retainedFromVm ? (
              <DetailField
                label="Retained from"
                value={
                  <Text size="sm">
                    VM{" "}
                    <Text span c="dimmed">
                      {dv.retainedFromVm}
                    </Text>{" "}
                    <Badge size="xs" variant="light" color="grape" ml={4}>
                      retained
                    </Badge>
                  </Text>
                }
              />
            ) : null}
            <DetailField label="Source" value={dv.sourceKind} />
            <DetailField label="Source detail" value={dv.sourceDetail} />
            <DetailField label="UID" value={dv.uid ? <Code>{dv.uid}</Code> : undefined} />
          </SimpleGrid>
        </DetailSection>
      </SimpleGrid>

      <DetailSection title="Conditions">
        <ResourceTable
          isEmpty={dv.conditions.length === 0}
          emptyMessage="No conditions"
          headers={["Type", "Status", "Reason", "Message", "Last transition"]}
        >
          {dv.conditions.map((c) => (
            <Table.Tr key={c.type}>
              <Table.Td>{c.type}</Table.Td>
              <Table.Td>
                <Badge
                  size="sm"
                  variant="light"
                  color={
                    c.status === "True"
                      ? "teal"
                      : c.status === "False"
                        ? "gray"
                        : "yellow"
                  }
                >
                  {c.status}
                </Badge>
              </Table.Td>
              <Table.Td>{c.reason ?? "—"}</Table.Td>
              <Table.Td>
                <ClampedText size="sm" c="dimmed" maw={420} lineClamp={3}>
                  {c.message ?? "—"}
                </ClampedText>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {formatDateTime(c.lastTransitionTime)}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </ResourceTable>
      </DetailSection>
    </Stack>
  );
}
