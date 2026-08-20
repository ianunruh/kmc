import { ActionIcon, Code, Group, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy, IconEye, IconEyeOff } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Multiline copyable snippet (SSH config, one-liners). */
export function CopyableBlock({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const text = value.trim();
  if (!text) return null;
  return (
    <Group gap="xs" align="flex-start" wrap="nowrap">
      <Code block style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {text}
      </Code>
      <CopyButton value={text} label={label} />
    </Group>
  );
}

/** Compact copy button for addresses, hosts, VIP values. */
export function CopyButton({
  value,
  label = "Copy",
  size = "sm",
}: {
  value: string;
  label?: string;
  size?: "xs" | "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const text = value.trim();
  if (!text) return null;

  return (
    <Tooltip label={copied ? "Copied" : label} withArrow>
      <ActionIcon
        variant="subtle"
        color="gray"
        size={size}
        aria-label={label}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void copyText(text).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </ActionIcon>
    </Tooltip>
  );
}

/** Value + optional monospace display with a copy control. */
export function CopyableValue({
  value,
  display,
  code = true,
  dimmed,
  size = "sm",
}: {
  value: string;
  /** Override displayed text (defaults to value). */
  display?: ReactNode;
  code?: boolean;
  dimmed?: boolean;
  size?: "xs" | "sm";
}) {
  const text = value.trim();
  if (!text) {
    return (
      <Text size={size} c="dimmed">
        —
      </Text>
    );
  }

  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
      {code ? (
        <Code style={{ wordBreak: "break-all" }}>{display ?? text}</Code>
      ) : (
        <Text
          size={size}
          c={dimmed ? "dimmed" : undefined}
          style={{ wordBreak: "break-all" }}
        >
          {display ?? text}
        </Text>
      )}
      <CopyButton value={text} size="xs" />
    </Group>
  );
}

/**
 * Sensitive value (password / URI with password). Hidden by default; copy
 * always uses the full secret. Reveal toggles on-screen text only.
 */
export function RevealableValue({
  value,
  mask = "••••••••••••",
  size = "sm",
}: {
  value: string;
  /** Placeholder when hidden. */
  mask?: string;
  size?: "xs" | "sm";
}) {
  const [revealed, setRevealed] = useState(false);
  const text = value.trim();
  if (!text) {
    return (
      <Text size={size} c="dimmed">
        —
      </Text>
    );
  }

  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
      <Code style={{ wordBreak: "break-all" }}>{revealed ? text : mask}</Code>
      <Tooltip label={revealed ? "Hide" : "Reveal"} withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="xs"
          aria-label={revealed ? "Hide value" : "Reveal value"}
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? <IconEyeOff size={14} /> : <IconEye size={14} />}
        </ActionIcon>
      </Tooltip>
      <CopyButton value={text} size="xs" label="Copy" />
    </Group>
  );
}
