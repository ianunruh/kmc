import { Badge, Text } from "@mantine/core";
import { ClampedText } from "./clamped-text";
import { DetailSection } from "./detail-section";
import { ResourceTable, Table } from "./resource-table";
import { formatDateTime } from "~/lib/format";
import type { VmCondition } from "~/lib/types";

/**
 * Standard Kubernetes conditions table used on resource detail overview tabs
 * (VMs, DataVolumes, CNPG, networking CRs, etc.).
 */
export function ConditionsSection({
  conditions,
  title = "Conditions",
}: {
  conditions: VmCondition[];
  title?: string;
}) {
  return (
    <DetailSection title={title}>
      <ResourceTable
        isEmpty={conditions.length === 0}
        emptyMessage="No conditions"
        headers={["Type", "Status", "Reason", "Message", "Last transition"]}
      >
        {conditions.map((c) => (
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
  );
}
