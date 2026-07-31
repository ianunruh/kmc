import { Group } from "@mantine/core";
import type { ReactNode } from "react";

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <Group mb="md" align="flex-end" wrap="wrap">
      {children}
    </Group>
  );
}
