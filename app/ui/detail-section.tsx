import { Text } from "@mantine/core";
import type { ReactNode } from "react";
import { ConsolePaper } from "./console-paper";

export function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <ConsolePaper>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="sm">
        {title}
      </Text>
      {children}
    </ConsolePaper>
  );
}
