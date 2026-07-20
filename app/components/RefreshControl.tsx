import {
  ActionIcon,
  Group,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useRefresh } from "~/lib/refresh";

export function RefreshControl() {
  const { enabled, setEnabled, intervalSec, refreshNow } = useRefresh();

  return (
    <Group
      gap="xs"
      wrap="nowrap"
      px={8}
      py={4}
      style={{
        border: "1px solid #1e242c",
        borderRadius: 6,
        background: "#0b0d0f",
      }}
    >
      <Group gap={6} wrap="nowrap">
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: enabled ? "#20c997" : "#868e96",
          }}
        />
        <Text size="xs" c="dimmed">
          {enabled ? "auto on" : "auto off"}
        </Text>
      </Group>

      <Tooltip label="Refresh now" withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={refreshNow}
          aria-label="Refresh now"
        >
          <IconRefresh size={14} />
        </ActionIcon>
      </Tooltip>

      <Switch
        size="xs"
        checked={enabled}
        onChange={(e) => setEnabled(e.currentTarget.checked)}
        aria-label={`Auto-refresh every ${intervalSec}s`}
      />
    </Group>
  );
}
