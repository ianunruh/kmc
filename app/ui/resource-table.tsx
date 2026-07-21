import { Table, Text } from "@mantine/core";
import type { ReactNode } from "react";

export function ResourceTable({
  headers,
  children,
  emptyMessage = "No resources found.",
  isEmpty,
}: {
  headers: ReactNode[];
  children: ReactNode;
  emptyMessage?: string;
  isEmpty?: boolean;
}) {
  if (isEmpty) {
    return (
      <Text c="dimmed" size="sm" py="xl" ta="center">
        {emptyMessage}
      </Text>
    );
  }

  return (
    <Table
      className="kmc-table"
      highlightOnHover
      verticalSpacing="sm"
      horizontalSpacing="md"
      withRowBorders
    >
      <Table.Thead>
        <Table.Tr>
          {headers.map((header, i) => (
            <Table.Th key={i}>{header}</Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>{children}</Table.Tbody>
    </Table>
  );
}

export { Table };
