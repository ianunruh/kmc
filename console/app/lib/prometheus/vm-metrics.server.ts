import { getClusterPrometheusUrl } from "~/lib/k8s/cluster-config.server";
import type { ClusterId } from "~/lib/types";
import {
  promEscapeLabel,
  promQuery,
  promQueryRange,
  type PromRangeSample,
} from "./client.server";
import type { MetricsRange, SeriesPoint, VmMetricsSnapshot } from "./types";

export type { MetricsRange, MetricSeries, SeriesPoint, VmMetricsSnapshot } from "./types";
export { METRICS_RANGES } from "./types";

const RANGE_CONFIG: Record<
  MetricsRange,
  { durationSec: number; stepSec: number; rateWindow: string }
> = {
  "1h": { durationSec: 3600, stepSec: 15, rateWindow: "1m" },
  "6h": { durationSec: 6 * 3600, stepSec: 60, rateWindow: "2m" },
  "24h": { durationSec: 24 * 3600, stepSec: 5 * 60, rateWindow: "5m" },
};

export function parseMetricsRange(raw: string | null | undefined): MetricsRange {
  if (raw === "1h" || raw === "6h" || raw === "24h") return raw;
  return "1h";
}

function vmSelector(namespace: string, name: string): string {
  return `namespace="${promEscapeLabel(namespace)}",name="${promEscapeLabel(name)}"`;
}

function toPoints(sample: PromRangeSample | undefined): SeriesPoint[] {
  if (!sample?.values?.length) return [];
  return sample.values.map(([t, v]) => ({
    t: Math.floor(t),
    v: Number(v),
  }));
}

function sumSeries(samples: PromRangeSample[]): SeriesPoint[] {
  if (samples.length === 0) return [];
  if (samples.length === 1) return toPoints(samples[0]);

  const byT = new Map<number, number>();
  for (const s of samples) {
    for (const [t, v] of s.values) {
      const key = Math.floor(t);
      byT.set(key, (byT.get(key) ?? 0) + Number(v));
    }
  }
  return [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

function lastValue(points: SeriesPoint[]): number | undefined {
  if (!points.length) return undefined;
  return points[points.length - 1]!.v;
}

function emptyCharts(): VmMetricsSnapshot["charts"] {
  return { cpu: [], memory: [], network: [], disk: [] };
}

/**
 * Fetch VM-level KubeVirt metrics from the cluster's Prometheus (if configured).
 * Safe to call when prometheus is not configured — returns configured:false.
 */
export async function getVmMetrics(opts: {
  cluster: ClusterId;
  namespace: string;
  name: string;
  range?: MetricsRange;
}): Promise<VmMetricsSnapshot> {
  const range = opts.range ?? "1h";
  const cfg = RANGE_CONFIG[range];
  const end = Math.floor(Date.now() / 1000);
  const start = end - cfg.durationSec;

  const base: VmMetricsSnapshot = {
    configured: false,
    range,
    stepSec: cfg.stepSec,
    start,
    end,
    empty: true,
    current: {},
    charts: emptyCharts(),
  };

  const promUrl = getClusterPrometheusUrl(opts.cluster);
  if (!promUrl) {
    return base;
  }
  base.configured = true;

  const sel = vmSelector(opts.namespace, opts.name);
  const rw = cfg.rateWindow;

  const queries = {
    cpu: `sum(rate(kubevirt_vmi_cpu_usage_seconds_total{${sel}}[${rw}]))`,
    memUsed: `kubevirt_vmi_memory_used_bytes{${sel}}`,
    memResident: `kubevirt_vmi_memory_resident_bytes{${sel}}`,
    memAvailable: `kubevirt_vmi_memory_available_bytes{${sel}}`,
    memDomain: `kubevirt_vmi_memory_domain_bytes{${sel}}`,
    netRx: `sum(rate(kubevirt_vmi_network_receive_bytes_total{${sel}}[${rw}]))`,
    netTx: `sum(rate(kubevirt_vmi_network_transmit_bytes_total{${sel}}[${rw}]))`,
    diskRead: `sum(rate(kubevirt_vmi_storage_read_traffic_bytes_total{${sel}}[${rw}]))`,
    diskWrite: `sum(rate(kubevirt_vmi_storage_write_traffic_bytes_total{${sel}}[${rw}]))`,
    node: `kubevirt_vmi_memory_resident_bytes{${sel}}`,
  } as const;

  try {
    const keys = [
      "cpu",
      "memUsed",
      "memResident",
      "memAvailable",
      "memDomain",
      "netRx",
      "netTx",
      "diskRead",
      "diskWrite",
    ] as const;

    const rangeResults = await Promise.all(
      keys.map(async (key) => {
        const result = await promQueryRange(
          promUrl,
          queries[key],
          start,
          end,
          cfg.stepSec,
        );
        return [key, result] as const;
      }),
    );

    const byKey = Object.fromEntries(rangeResults) as Record<
      (typeof keys)[number],
      PromRangeSample[]
    >;

    const cpuPoints = sumSeries(byKey.cpu);
    const memUsed = sumSeries(byKey.memUsed);
    const memResident = sumSeries(byKey.memResident);
    const memAvailable = sumSeries(byKey.memAvailable);
    const memDomain = sumSeries(byKey.memDomain);
    const netRx = sumSeries(byKey.netRx);
    const netTx = sumSeries(byKey.netTx);
    const diskRead = sumSeries(byKey.diskRead);
    const diskWrite = sumSeries(byKey.diskWrite);

    const hasAny =
      cpuPoints.length > 0 ||
      memUsed.length > 0 ||
      memResident.length > 0 ||
      netRx.length > 0 ||
      netTx.length > 0 ||
      diskRead.length > 0 ||
      diskWrite.length > 0;

    let node: string | undefined = byKey.memResident[0]?.metric?.node;
    if (!node) {
      try {
        const instant = await promQuery(promUrl, queries.node);
        node = instant[0]?.metric?.node;
      } catch {
        // node is optional
      }
    }

    base.empty = !hasAny;
    base.current = {
      cpuCores: lastValue(cpuPoints),
      memoryUsedBytes: lastValue(memUsed),
      memoryResidentBytes: lastValue(memResident),
      memoryAvailableBytes: lastValue(memAvailable),
      memoryDomainBytes: lastValue(memDomain),
      networkReceiveBytesPerSec: lastValue(netRx),
      networkTransmitBytesPerSec: lastValue(netTx),
      diskReadBytesPerSec: lastValue(diskRead),
      diskWriteBytesPerSec: lastValue(diskWrite),
      node,
    };
    base.charts = {
      cpu: [{ id: "cpu", label: "CPU", points: cpuPoints }],
      memory: [
        { id: "used", label: "Used", points: memUsed },
        { id: "resident", label: "Resident", points: memResident },
        { id: "available", label: "Available", points: memAvailable },
        { id: "domain", label: "Domain", points: memDomain },
      ].filter((s) => s.points.length > 0),
      network: [
        { id: "rx", label: "Receive", points: netRx },
        { id: "tx", label: "Transmit", points: netTx },
      ].filter((s) => s.points.length > 0),
      disk: [
        { id: "read", label: "Read", points: diskRead },
        { id: "write", label: "Write", points: diskWrite },
      ].filter((s) => s.points.length > 0),
    };
    return base;
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
    base.empty = true;
    return base;
  }
}
