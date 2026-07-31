import { Alert, Group, SegmentedControl, SimpleGrid, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { MetricsRange, VmMetricsSnapshot } from "~/lib/prometheus/types";
import { useRefresh } from "~/lib/refresh";
import { ConsolePaper } from "~/ui";
import { TimeSeriesChart } from "./time-series-chart";

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

function formatBytesPerSec(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `${formatBytes(v)}/s`;
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

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
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

function ChartBlock({ title, children }: { title: string; children: React.ReactNode }) {
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
  return `/api/vms/${encodeURIComponent(cluster)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/metrics?range=${range}`;
}

export function VmMetricsPanel({
  cluster,
  namespace,
  name,
}: {
  cluster: string;
  namespace: string;
  name: string;
}) {
  const [range, setRange] = useState<MetricsRange>("1h");
  const fetcher = useFetcher<VmMetricsSnapshot>();
  const { lastRefreshedAt } = useRefresh();

  const url = metricsUrl(cluster, namespace, name, range);

  useEffect(() => {
    // Client-side load of Prometheus-backed series; re-runs on range change
    // and when the global auto-refresh cycle completes.
    fetcher.load(url);
    // fetcher identity is stable enough; depend on url + refresh tick only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, lastRefreshedAt]);

  const data = fetcher.data;
  const loading = fetcher.state === "loading" || (fetcher.state === "idle" && !data);

  // Not configured for this cluster — hide the whole panel.
  if (data && !data.configured) {
    return null;
  }

  const cur = data?.current;
  const cpuLabel = cur?.cpuCores != null ? `${formatCores(cur.cpuCores)} cores` : "—";
  const memLabel =
    cur?.memoryUsedBytes != null
      ? formatBytes(cur.memoryUsedBytes)
      : cur?.memoryResidentBytes != null
        ? formatBytes(cur.memoryResidentBytes)
        : "—";
  const memHint =
    cur?.memoryDomainBytes != null
      ? `of ${formatBytes(cur.memoryDomainBytes)} domain`
      : cur?.memoryResidentBytes != null && cur?.memoryUsedBytes != null
        ? `RSS ${formatBytes(cur.memoryResidentBytes)}`
        : undefined;
  const netRx = cur?.networkReceiveBytesPerSec ?? 0;
  const netTx = cur?.networkTransmitBytesPerSec ?? 0;
  const netLabel =
    cur?.networkReceiveBytesPerSec != null || cur?.networkTransmitBytesPerSec != null
      ? `${formatBytesPerSec(netRx + netTx)}`
      : "—";
  const netHint =
    cur?.networkReceiveBytesPerSec != null
      ? `↓ ${formatBytesPerSec(netRx)}  ↑ ${formatBytesPerSec(netTx)}`
      : undefined;
  const diskR = cur?.diskReadBytesPerSec ?? 0;
  const diskW = cur?.diskWriteBytesPerSec ?? 0;
  const diskLabel =
    cur?.diskReadBytesPerSec != null || cur?.diskWriteBytesPerSec != null
      ? formatBytesPerSec(diskR + diskW)
      : "—";
  const diskHint =
    cur?.diskReadBytesPerSec != null
      ? `R ${formatBytesPerSec(diskR)}  W ${formatBytesPerSec(diskW)}`
      : undefined;

  return (
    <ConsolePaper>
      <Group justify="space-between" align="center" mb="sm" wrap="wrap" gap="sm">
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Metrics
          </Text>
          {cur?.node && (
            <Text size="xs" c="dimmed" mt={2}>
              node {cur.node}
              {fetcher.state === "loading" ? " · refreshing…" : ""}
            </Text>
          )}
          {!cur?.node && loading && (
            <Text size="xs" c="dimmed" mt={2}>
              loading…
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
          No KubeVirt VMI metrics found for this VM. It may be stopped, or the cluster
          Prometheus is not scraping kubevirt metrics yet.
        </Alert>
      )}

      <Stack gap="md">
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
          <Stat label="CPU" value={cpuLabel} />
          <Stat label="Memory" value={memLabel} hint={memHint} />
          <Stat label="Network" value={netLabel} hint={netHint} />
          <Stat label="Disk" value={diskLabel} hint={diskHint} />
        </SimpleGrid>

        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          <ChartBlock title="CPU">
            <TimeSeriesChart
              series={data?.charts.cpu ?? []}
              formatValue={(v) => `${formatCores(v)}c`}
              formatTime={(t) => formatChartTime(t, range)}
              emptyLabel={loading ? "Loading…" : "No CPU series"}
            />
          </ChartBlock>
          <ChartBlock title="Memory">
            <TimeSeriesChart
              series={data?.charts.memory ?? []}
              formatValue={formatBytes}
              formatTime={(t) => formatChartTime(t, range)}
              emptyLabel={loading ? "Loading…" : "No memory series"}
            />
          </ChartBlock>
          <ChartBlock title="Network">
            <TimeSeriesChart
              series={data?.charts.network ?? []}
              formatValue={formatBytesPerSec}
              formatTime={(t) => formatChartTime(t, range)}
              emptyLabel={loading ? "Loading…" : "No network series"}
            />
          </ChartBlock>
          <ChartBlock title="Disk">
            <TimeSeriesChart
              series={data?.charts.disk ?? []}
              formatValue={formatBytesPerSec}
              formatTime={(t) => formatChartTime(t, range)}
              emptyLabel={loading ? "Loading…" : "No disk series"}
            />
          </ChartBlock>
        </SimpleGrid>
      </Stack>
    </ConsolePaper>
  );
}
