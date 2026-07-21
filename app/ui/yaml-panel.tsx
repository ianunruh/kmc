import { ActionIcon, Box, Code, Group, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useState } from "react";
import { DetailSection } from "./detail-section";

export function YamlPanel({
  yaml,
  title = "YAML",
  maxHeight = 420,
}: {
  yaml: string;
  title?: string;
  maxHeight?: number | string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(yaml);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can fail without a secure context; ignore.
    }
  }

  return (
    <DetailSection title={title}>
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Text size="xs" c="dimmed">
          Read-only · managedFields stripped
        </Text>
        <Tooltip label={copied ? "Copied" : "Copy YAML"} withArrow>
          <ActionIcon
            variant="default"
            size="sm"
            aria-label="Copy YAML"
            onClick={() => void copy()}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionIcon>
        </Tooltip>
      </Group>
      <Box
        className="kmc-yaml"
        style={{
          maxHeight,
          overflow: "auto",
          borderRadius: 4,
          border: "1px solid #1e242c",
          background: "#0b0d0f",
        }}
      >
        <Code
          block
          style={{
            background: "transparent",
            color: "#c5ced9",
            fontSize: 12,
            lineHeight: 1.55,
            margin: 0,
            padding: "12px 14px",
            whiteSpace: "pre",
          }}
        >
          {yaml || "—"}
        </Code>
      </Box>
    </DetailSection>
  );
}
