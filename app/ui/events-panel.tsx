import { Badge, Text } from "@mantine/core";
import type { CSSProperties } from "react";
import type { ResourceEvent } from "~/lib/types";
import { formatAge } from "~/lib/format";
import { DetailSection } from "./detail-section";
import { ResourceTable, Table } from "./resource-table";

export function EventsPanel({
  events,
  title = "Events",
  /** Show involved object kind column (useful when multiple kinds share a name). */
  showKind = false,
  emptyMessage = "No events found for this resource.",
}: {
  events: ResourceEvent[];
  title?: string;
  showKind?: boolean;
  emptyMessage?: string;
}) {
  const headers = showKind
    ? ["Type", "Reason", "Object", "Age", "Count", "Source", "Message"]
    : ["Type", "Reason", "Age", "Count", "Source", "Message"];

  return (
    <DetailSection title={title}>
      <ResourceTable
        isEmpty={events.length === 0}
        emptyMessage={emptyMessage}
        headers={headers}
      >
        {events.map((ev, i) => (
          <Table.Tr key={`${ev.reason}-${ev.lastTimestamp ?? ""}-${i}`}>
            <Table.Td style={fitCell}>
              <EventTypeBadge type={ev.type} />
            </Table.Td>
            <Table.Td style={nowrapCell}>{ev.reason}</Table.Td>
            {showKind && (
              <Table.Td style={nowrapCell}>
                <Text size="sm" c="dimmed">
                  {ev.involvedKind ?? "—"}
                </Text>
              </Table.Td>
            )}
            <Table.Td style={fitCell}>
              <Text size="sm" c="dimmed" title={ev.lastTimestamp}>
                {formatAge(ev.lastTimestamp ?? ev.firstTimestamp ?? "")}
              </Text>
            </Table.Td>
            <Table.Td style={fitCell}>
              <Text size="sm" c="dimmed">
                {ev.count}
              </Text>
            </Table.Td>
            <Table.Td style={nowrapCell}>
              <Text size="sm" c="dimmed" lineClamp={1} maw={140}>
                {ev.source ?? "—"}
              </Text>
            </Table.Td>
            <Table.Td style={{ width: "100%" }}>
              <Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {ev.message || "—"}
              </Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </ResourceTable>
    </DetailSection>
  );
}

/** Shrink-to-content columns that must not clip badges / short values */
const fitCell: CSSProperties = {
  width: 1,
  whiteSpace: "nowrap",
};

const nowrapCell: CSSProperties = {
  whiteSpace: "nowrap",
};

function EventTypeBadge({ type }: { type: string }) {
  const normalized = type || "Normal";
  const color =
    normalized === "Warning" ? "yellow" : normalized === "Error" ? "red" : "teal";
  return (
    <Badge
      size="sm"
      variant="light"
      color={color}
      tt="uppercase"
      styles={{
        root: {
          flexShrink: 0,
          overflow: "visible",
          textOverflow: "clip",
          maxWidth: "none",
        },
        label: {
          overflow: "visible",
          textOverflow: "clip",
          whiteSpace: "nowrap",
        },
      }}
    >
      {normalized}
    </Badge>
  );
}
