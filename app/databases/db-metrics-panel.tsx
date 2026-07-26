import { Alert, Group, SegmentedControl, SimpleGrid, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type {
  DatabaseMetricsSnapshot,
  MetricsRange,
} from "~/lib/prometheus/types";
import { useRefresh } from "~/lib/refresh";
import { ConsolePaper } from "~/ui";
import { TimeSeriesChart } from "~/vms/time-series-chart";

function formatCores(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v < 0.01) return `${(v * 1000).toFixed(1)}m`;
  if (v < 10) return `${v.toFixed(3)}`;
  return `${v.toFixed(2)}`;
}

function formatBytes(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs < 1024) return `${v.toFixed(0)} B`;
  if (abs < 1024 ** 2) return `${(v / 1024).toFixed(1)} KiB`;
  if (abs < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MiB`;
  if (abs < 1024 ** 4) return `${(v / 1024 ** 3).toFixed(2)} GiB`;
  return `${(v / 1024 ** 4).toFixed(2)} TiB`;
}

function formatRate(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v < 0.01 && v > 0) return v.toFixed(3);
  if (v < 10) return v.toFixed(2);
  if (v < 100) return v.toFixed(1);
  return v.toFixed(0);
}

function formatLag(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v < 1) return `${(v * 1000).toFixed(0)} ms`;
  if (v < 60) return `${v.toFixed(1)} s`;
  if (v < 3600) return `${(v / 60).toFixed(1)} m`;
  return `${(v / 3600).toFixed(1)} h`;
}

function formatPercent(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function formatChartTime(t: number, range: MetricsRange): string {
  const d = new Date(t * 1000);
  if (range === "24h") {
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      style={{
        background: "#0e1115",
        border: "1px solid #1e242c",
        borderRadius: 4,
        padding: "10px 12px",
      }}
    >
      <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={4}>
        {label}
      </Text>
      <Text size="lg" fw={600} style={{ fontVariantNumeric: "tabular-nums" }}>
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed" mt={2}>
          {hint}
        </Text>
      )}
    </div>
  );
}

function ChartBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={6}>
        {title}
      </Text>
      {children}
    </div>
  );
}

function metricsUrl(
  cluster: string,
  namespace: string,
  name: string,
  range: MetricsRange,
): string {
  return `/api/databases/${encodeURIComponent(cluster)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/metrics?range=${range}`;
}

export function DatabaseMetricsPanel({
  cluster,
  namespace,
  name,
}: {
  cluster: string;
  namespace: string;
  name: string;
}) {
  const [range, setRange] = useState<MetricsRange>("1h");
  const fetcher = useFetcher<DatabaseMetricsSnapshot>();
  const { lastRefreshedAt } = useRefresh();

  const url = metricsUrl(cluster, namespace, name, range);

  useEffect(() => {
    fetcher.load(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, lastRefreshedAt]);

  const data = fetcher.data;
  const loading =
    fetcher.state === "loading" || (fetcher.state === "idle" && !data);

  // Not configured for this cluster — hide the whole panel.
  if (data && !data.configured) {
    return null;
  }

  const cur = data?.current;
  const connLabel =
    cur?.connections != null ? formatRate(cur.connections) : "—";
  const connHint =
    cur?.connectionsActive != null || cur?.connectionsIdle != null
      ? [
          cur.connectionsActive != null
            ? `${formatRate(cur.connectionsActive)} active`
            : null,
          cur.connectionsIdle != null
            ? `${formatRate(cur.connectionsIdle)} idle`
            : null,
          cur.connectionsWaiting != null && cur.connectionsWaiting > 0
            ? `${formatRate(cur.connectionsWaiting)} waiting`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : undefined;

  const txnLabel =
    cur?.commitsPerSec != null ? `${formatRate(cur.commitsPerSec)}/s` : "—";
  const txnHint =
    cur?.rollbacksPerSec != null && cur.rollbacksPerSec > 0
      ? `${formatRate(cur.rollbacksPerSec)}/s rollbacks`
      : cur?.cacheHitRatio != null
        ? `cache hit ${formatPercent(cur.cacheHitRatio)}`
        : undefined;

  const sizeLabel =
    cur?.databaseSizeBytes != null ? formatBytes(cur.databaseSizeBytes) : "—";

  const memLabel =
    cur?.memoryBytes != null ? formatBytes(cur.memoryBytes) : "—";
  const memHint =
    cur?.cpuCores != null
      ? `CPU ${formatCores(cur.cpuCores)} cores`
      : cur?.replicationLagSeconds != null
        ? `lag ${formatLag(cur.replicationLagSeconds)}`
        : undefined;

  return (
    <ConsolePaper>
      <Group justify="space-between" align="center" mb="sm" wrap="wrap" gap="sm">
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Metrics
          </Text>
          {loading && (
            <Text size="xs" c="dimmed" mt={2}>
              {fetcher.state === "loading" ? "refreshing…" : "loading…"}
            </Text>
          )}
          {!loading && cur?.replicationLagSeconds != null && (
            <Text size="xs" c="dimmed" mt={2}>
              replication lag {formatLag(cur.replicationLagSeconds)}
            </Text>
          )}
        </div>
        <SegmentedControl
          size="xs"
          value={range}
          onChange={(v) => setRange(v as MetricsRange)}
          data={[
            { label: "1h", value: "1h" },
            { label: "6h", value: "6h" },
            { label: "24h", value: "24h" },
          ]}
        />
      </Group>

      {data?.error && (
        <Alert color="red" variant="light" title="Prometheus error" mb="sm">
          {data.error}
        </Alert>
      )}

      {data?.configured && data.empty && !data.error && !loading && (
        <Alert color="gray" variant="light" mb="sm">
          No CloudNativePG metrics found for this cluster. Pods may still be
          starting, or the Prometheus PodMonitor may not be scraping yet.
        </Alert>
      )}

      <Stack gap="md">
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
          <Stat label="Connections" value={connLabel} hint={connHint} />
          <Stat label="Transactions" value={txnLabel} hint={txnHint} />
          <Stat label="Database size" value={sizeLabel} />
          <Stat label="Memory" value={memLabel} hint={memHint} />
        </SimpleGrid>

        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          <ChartBlock title="Connections">
            <TimeSeriesChart
              series={data?.charts.connections ?? []}
              formatValue={(v) => formatRate(v)}
              formatTime={(t) => formatChartTime(t, range)}
              emptyLabel={loading ? "Loading…" : "No connection series"}
            />
          </ChartBlock>
          <ChartBlock title="Transactions">
            <TimeSeriesChart
              series={data?.charts.transactions ?? []}
              formatValue={(v) => `${formatRate(v)}/s`}
              formatTime={(t) => formatChartTime(t, range)}
              emptyLabel={loading ? "Loading…" : "No transaction series"}
            />
          </ChartBlock>
          <ChartBlock title="Tuples">
            <TimeSeriesChart
              series={data?.charts.tuples ?? []}
              formatValue={(v) => `${formatRate(v)}/s`}
              formatTime={(t) => formatChartTime(t, range)}
              emptyLabel={loading ? "Loading…" : "No tuple series"}
            />
          </ChartBlock>
          <ChartBlock title="Resources">
            <TimeSeriesChart
              series={data?.charts.resources ?? []}
              formatValue={(v) =>
                // Mixed units (cores + GiB) — keep compact numeric.
                formatRate(v)
              }
              formatTime={(t) => formatChartTime(t, range)}
              emptyLabel={loading ? "Loading…" : "No resource series"}
            />
          </ChartBlock>
        </SimpleGrid>
      </Stack>
    </ConsolePaper>
  );
}
