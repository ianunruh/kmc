import { getClusterPrometheus } from "~/lib/k8s/cluster-config.server";
import type { ClusterId } from "~/lib/types";
import {
  promEscapeLabel,
  promQueryRange,
  type PromClient,
  type PromRangeSample,
} from "./client.server";
import type {
  DatabaseMetricsSnapshot,
  MetricsRange,
  SeriesPoint,
} from "./types";
import { parseMetricsRange } from "./vm-metrics.server";

export type { DatabaseMetricsSnapshot } from "./types";
export { parseMetricsRange };

const RANGE_CONFIG: Record<
  MetricsRange,
  { durationSec: number; stepSec: number; rateWindow: string }
> = {
  "1h": { durationSec: 3600, stepSec: 15, rateWindow: "1m" },
  "6h": { durationSec: 6 * 3600, stepSec: 60, rateWindow: "2m" },
  "24h": { durationSec: 24 * 3600, stepSec: 5 * 60, rateWindow: "5m" },
};

/** Escape a value for use inside a Prometheus regex label matcher. */
function promEscapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match CNPG instance pods (`{name}-1`, `{name}-2`, …) in a namespace.
 * Prefer pod regex over `cluster=` — not all cnpg_* series carry that label.
 */
function instanceSelector(namespace: string, name: string): string {
  const ns = promEscapeLabel(namespace);
  const podRe = `${promEscapeRegex(name)}-[0-9]+`;
  return `namespace="${ns}",pod=~"${podRe}"`;
}

/** App DBs only — skip template* and the default `postgres` maintenance DB. */
const APP_DATNAME = 'datname!="",datname!~"template.*|postgres"';

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
  return [...byT.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => ({ t, v }));
}

function maxSeries(samples: PromRangeSample[]): SeriesPoint[] {
  if (samples.length === 0) return [];
  if (samples.length === 1) return toPoints(samples[0]);

  const byT = new Map<number, number>();
  for (const s of samples) {
    for (const [t, v] of s.values) {
      const key = Math.floor(t);
      const n = Number(v);
      const prev = byT.get(key);
      byT.set(key, prev == null ? n : Math.max(prev, n));
    }
  }
  return [...byT.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => ({ t, v }));
}

function lastValue(points: SeriesPoint[]): number | undefined {
  if (!points.length) return undefined;
  return points[points.length - 1]!.v;
}

function emptyCharts(): DatabaseMetricsSnapshot["charts"] {
  return {
    connections: [],
    transactions: [],
    tuples: [],
    resources: [],
  };
}

async function queryRange(
  client: PromClient,
  query: string,
  start: number,
  end: number,
  step: number,
): Promise<SeriesPoint[]> {
  const samples = await promQueryRange(client, query, start, end, step);
  return sumSeries(samples);
}

async function queryRangeMax(
  client: PromClient,
  query: string,
  start: number,
  end: number,
  step: number,
): Promise<SeriesPoint[]> {
  const samples = await promQueryRange(client, query, start, end, step);
  return maxSeries(samples);
}

/**
 * High-level metrics for a CloudNativePG Cluster from the cluster Prometheus.
 * Safe when prometheus is not configured — returns configured:false.
 */
export async function getDatabaseMetrics(opts: {
  cluster: ClusterId;
  namespace: string;
  name: string;
  range?: MetricsRange;
}): Promise<DatabaseMetricsSnapshot> {
  const range = opts.range ?? "1h";
  const cfg = RANGE_CONFIG[range];
  const end = Math.floor(Date.now() / 1000);
  const start = end - cfg.durationSec;

  const base: DatabaseMetricsSnapshot = {
    configured: false,
    range,
    stepSec: cfg.stepSec,
    start,
    end,
    empty: true,
    current: {},
    charts: emptyCharts(),
  };

  const prom = getClusterPrometheus(opts.cluster);
  if (!prom) {
    return base;
  }
  base.configured = true;

  const sel = instanceSelector(opts.namespace, opts.name);
  const rw = cfg.rateWindow;
  const app = `${sel},${APP_DATNAME}`;

  // Size: max-by-datname first so multi-instance clusters are not double-counted.
  const sizeQuery = `sum(max by (datname) (cnpg_pg_database_size_bytes{${sel},datname!~"template.*"}))`;

  const queries = {
    connections: `sum(cnpg_backends_total{${sel}})`,
    connectionsActive: `sum(cnpg_backends_total{${sel},state="active"})`,
    connectionsIdle: `sum(cnpg_backends_total{${sel},state="idle"})`,
    connectionsWaiting: `sum(cnpg_backends_waiting_total{${sel}})`,
    commits: `sum(rate(cnpg_pg_stat_database_xact_commit{${app}}[${rw}]))`,
    rollbacks: `sum(rate(cnpg_pg_stat_database_xact_rollback{${app}}[${rw}]))`,
    size: sizeQuery,
    lag: `max(cnpg_pg_replication_lag{${sel}})`,
    cpu: `sum(rate(container_cpu_usage_seconds_total{${sel},container="postgres"}[${rw}]))`,
    memory: `sum(container_memory_working_set_bytes{${sel},container="postgres"})`,
    blksHit: `sum(rate(cnpg_pg_stat_database_blks_hit{${app}}[${rw}]))`,
    blksRead: `sum(rate(cnpg_pg_stat_database_blks_read{${app}}[${rw}]))`,
    tupFetched: `sum(rate(cnpg_pg_stat_database_tup_fetched{${app}}[${rw}]))`,
    tupInserted: `sum(rate(cnpg_pg_stat_database_tup_inserted{${app}}[${rw}]))`,
    tupUpdated: `sum(rate(cnpg_pg_stat_database_tup_updated{${app}}[${rw}]))`,
    tupDeleted: `sum(rate(cnpg_pg_stat_database_tup_deleted{${app}}[${rw}]))`,
  } as const;

  try {
    const [
      connections,
      connectionsActive,
      connectionsIdle,
      connectionsWaiting,
      commits,
      rollbacks,
      size,
      lag,
      cpu,
      memory,
      blksHit,
      blksRead,
      tupFetched,
      tupInserted,
      tupUpdated,
      tupDeleted,
    ] = await Promise.all([
      queryRange(prom, queries.connections, start, end, cfg.stepSec),
      queryRange(prom, queries.connectionsActive, start, end, cfg.stepSec),
      queryRange(prom, queries.connectionsIdle, start, end, cfg.stepSec),
      queryRange(prom, queries.connectionsWaiting, start, end, cfg.stepSec),
      queryRange(prom, queries.commits, start, end, cfg.stepSec),
      queryRange(prom, queries.rollbacks, start, end, cfg.stepSec),
      queryRange(prom, queries.size, start, end, cfg.stepSec),
      queryRangeMax(prom, queries.lag, start, end, cfg.stepSec),
      queryRange(prom, queries.cpu, start, end, cfg.stepSec),
      queryRange(prom, queries.memory, start, end, cfg.stepSec),
      queryRange(prom, queries.blksHit, start, end, cfg.stepSec),
      queryRange(prom, queries.blksRead, start, end, cfg.stepSec),
      queryRange(prom, queries.tupFetched, start, end, cfg.stepSec),
      queryRange(prom, queries.tupInserted, start, end, cfg.stepSec),
      queryRange(prom, queries.tupUpdated, start, end, cfg.stepSec),
      queryRange(prom, queries.tupDeleted, start, end, cfg.stepSec),
    ]);

    // Cache hit ratio as a derived series (hit / (hit + read)).
    const cacheHitRatio: SeriesPoint[] = [];
    if (blksHit.length > 0 || blksRead.length > 0) {
      const byT = new Map<number, { hit: number; read: number }>();
      for (const p of blksHit) {
        const e = byT.get(p.t) ?? { hit: 0, read: 0 };
        e.hit = p.v;
        byT.set(p.t, e);
      }
      for (const p of blksRead) {
        const e = byT.get(p.t) ?? { hit: 0, read: 0 };
        e.read = p.v;
        byT.set(p.t, e);
      }
      for (const [t, { hit, read }] of [...byT.entries()].sort(
        (a, b) => a[0] - b[0],
      )) {
        const denom = hit + read;
        if (denom > 0) cacheHitRatio.push({ t, v: hit / denom });
      }
    }

    const hasAny =
      connections.length > 0 ||
      commits.length > 0 ||
      size.length > 0 ||
      cpu.length > 0 ||
      memory.length > 0 ||
      tupFetched.length > 0;

    base.empty = !hasAny;
    base.current = {
      connections: lastValue(connections),
      connectionsActive: lastValue(connectionsActive),
      connectionsIdle: lastValue(connectionsIdle),
      connectionsWaiting: lastValue(connectionsWaiting),
      commitsPerSec: lastValue(commits),
      rollbacksPerSec: lastValue(rollbacks),
      databaseSizeBytes: lastValue(size),
      replicationLagSeconds: lastValue(lag),
      cpuCores: lastValue(cpu),
      memoryBytes: lastValue(memory),
      cacheHitRatio: lastValue(cacheHitRatio),
      tupFetchedPerSec: lastValue(tupFetched),
      tupInsertedPerSec: lastValue(tupInserted),
      tupUpdatedPerSec: lastValue(tupUpdated),
      tupDeletedPerSec: lastValue(tupDeleted),
    };
    base.charts = {
      connections: [
        { id: "total", label: "Total", points: connections },
        { id: "active", label: "Active", points: connectionsActive },
        { id: "idle", label: "Idle", points: connectionsIdle },
        { id: "waiting", label: "Waiting", points: connectionsWaiting },
      ].filter((s) => s.points.length > 0),
      transactions: [
        { id: "commits", label: "Commits/s", points: commits },
        { id: "rollbacks", label: "Rollbacks/s", points: rollbacks },
      ].filter((s) => s.points.length > 0),
      tuples: [
        { id: "fetched", label: "Fetched/s", points: tupFetched },
        { id: "inserted", label: "Inserted/s", points: tupInserted },
        { id: "updated", label: "Updated/s", points: tupUpdated },
        { id: "deleted", label: "Deleted/s", points: tupDeleted },
      ].filter((s) => s.points.length > 0),
      resources: [
        { id: "cpu", label: "CPU cores", points: cpu },
        // Memory scaled to GiB for chart readability alongside CPU cores.
        {
          id: "memory",
          label: "Memory (GiB)",
          points: memory.map((p) => ({ t: p.t, v: p.v / 1024 ** 3 })),
        },
        {
          id: "size",
          label: "DB size (GiB)",
          points: size.map((p) => ({ t: p.t, v: p.v / 1024 ** 3 })),
        },
      ].filter((s) => s.points.length > 0),
    };
    return base;
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
    base.empty = true;
    return base;
  }
}
