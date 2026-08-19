import { Group, Text, Tooltip } from "@mantine/core";
import type { ClusterInfo } from "~/lib/types";

function probeLabel(c: ClusterInfo): string {
  const latency = c.latencyMs != null ? `${c.latencyMs}ms` : null;
  if (c.reachable) {
    return latency ? `readyz ${latency}` : "reachable";
  }
  const error = c.error || "unreachable";
  return latency ? `${error} · ${latency}` : error;
}

export function ClusterHealth({ clusters }: { clusters: ClusterInfo[] }) {
  return (
    <Group gap="md">
      {clusters.map((c) => (
        <Tooltip key={c.id} label={probeLabel(c)} withArrow>
          <Group gap={6}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: c.reachable ? "#20c997" : "#fa5252",
                boxShadow: c.reachable
                  ? "0 0 8px rgba(32,201,151,0.5)"
                  : "0 0 8px rgba(250,82,82,0.4)",
              }}
            />
            <Text size="xs" c="dimmed">
              {c.id}
            </Text>
          </Group>
        </Tooltip>
      ))}
    </Group>
  );
}
