import { createTheme, type MantineColorsTuple } from "@mantine/core";

const accent: MantineColorsTuple = [
  "#e6fffa",
  "#c3fae8",
  "#96f2d7",
  "#63e6be",
  "#38d9a9",
  "#20c997",
  "#12b886",
  "#0ca678",
  "#099268",
  "#087f5b",
];

export const theme = createTheme({
  primaryColor: "accent",
  colors: {
    accent,
  },
  fontFamily:
    '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontFamilyMonospace:
    '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  defaultRadius: "sm",
  headings: {
    fontFamily:
      '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontWeight: "600",
  },
  other: {
    consoleBg: "#0b0d0f",
    consolePanel: "#12151a",
    consoleBorder: "#1e242c",
  },
});
