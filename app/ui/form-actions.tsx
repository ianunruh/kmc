import { Group } from "@mantine/core";
import type { ReactNode } from "react";
import { ConsolePaper } from "./console-paper";

/** Sticky footer actions for full-page create/edit forms. */
export function FormActions({ children }: { children: ReactNode }) {
  return (
    <ConsolePaper
      style={{
        position: "sticky",
        bottom: 12,
        zIndex: 5,
      }}
    >
      <Group justify="flex-end">{children}</Group>
    </ConsolePaper>
  );
}
