import { Group, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { ConsolePaper } from "./console-paper";

export function DetailSection({
  title,
  actions,
  children,
}: {
  title: string;
  /** Optional header actions (right-aligned next to the title). */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ConsolePaper>
      <Group justify="space-between" align="center" mb="sm" gap="sm" wrap="wrap">
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          {title}
        </Text>
        {actions}
      </Group>
      {children}
    </ConsolePaper>
  );
}
