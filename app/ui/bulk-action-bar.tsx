import { Button, Group, Text } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * Toolbar shown when list rows are multi-selected for bulk actions.
 * Put action buttons in `children`; Clear is always available.
 */
export function BulkActionBar({
  selectedCount,
  onClear,
  children,
  disabled,
}: {
  selectedCount: number;
  onClear: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  if (selectedCount <= 0) return null;

  return (
    <Group
      justify="space-between"
      wrap="wrap"
      gap="sm"
      py="xs"
      px="sm"
      style={{
        borderRadius: 6,
        background: "var(--mantine-color-dark-6)",
        border: "1px solid var(--mantine-color-dark-4)",
      }}
    >
      <Text size="sm" fw={500}>
        {selectedCount} selected
      </Text>
      <Group gap="xs" wrap="wrap">
        {children}
        <Button variant="subtle" color="gray" size="xs" onClick={onClear} disabled={disabled}>
          Clear
        </Button>
      </Group>
    </Group>
  );
}
