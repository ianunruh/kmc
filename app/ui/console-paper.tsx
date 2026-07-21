import { Paper, type PaperProps } from "@mantine/core";
import type { ReactNode } from "react";

const consoleStyle = {
  background: "#12151a",
  border: "1px solid #1e242c",
  /* Prevent wide table content from expanding the page on mobile. */
  minWidth: 0,
  maxWidth: "100%",
} as const;

export function ConsolePaper({
  children,
  style,
  ...props
}: PaperProps & { children: ReactNode }) {
  return (
    <Paper p="md" radius="sm" style={{ ...consoleStyle, ...style }} {...props}>
      {children}
    </Paper>
  );
}
