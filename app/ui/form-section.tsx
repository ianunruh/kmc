import { Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { ConsolePaper } from "./console-paper";

export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <ConsolePaper>
      <Stack gap="sm">
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          {title}
        </Text>
        {children}
      </Stack>
    </ConsolePaper>
  );
}
