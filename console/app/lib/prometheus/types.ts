export type MetricsRange = "1h" | "6h" | "24h";

export const METRICS_RANGES: MetricsRange[] = ["1h", "6h", "24h"];

export type SeriesPoint = {
  /** Unix seconds */
  t: number;
  v: number;
};

export type MetricSeries = {
  id: string;
  label: string;
  points: SeriesPoint[];
};

export type VmMetricsSnapshot = {
  configured: boolean;
  range: MetricsRange;
  stepSec: number;
  start: number;
  end: number;
  /** True when Prometheus answered but no kubevirt VMI series for this VM. */
  empty: boolean;
  error?: string;
  current: {
    cpuCores?: number;
    memoryUsedBytes?: number;
    memoryResidentBytes?: number;
    memoryAvailableBytes?: number;
    memoryDomainBytes?: number;
    networkReceiveBytesPerSec?: number;
    networkTransmitBytesPerSec?: number;
    diskReadBytesPerSec?: number;
    diskWriteBytesPerSec?: number;
    node?: string;
  };
  charts: {
    cpu: MetricSeries[];
    memory: MetricSeries[];
    network: MetricSeries[];
    disk: MetricSeries[];
  };
};

/** High-level CloudNativePG / Postgres metrics for a Cluster. */
export type DatabaseMetricsSnapshot = {
  configured: boolean;
  range: MetricsRange;
  stepSec: number;
  start: number;
  end: number;
  /** True when Prometheus answered but no CNPG series for this cluster. */
  empty: boolean;
  error?: string;
  current: {
    connections?: number;
    connectionsActive?: number;
    connectionsIdle?: number;
    connectionsWaiting?: number;
    commitsPerSec?: number;
    rollbacksPerSec?: number;
    databaseSizeBytes?: number;
    replicationLagSeconds?: number;
    cpuCores?: number;
    memoryBytes?: number;
    cacheHitRatio?: number;
    tupFetchedPerSec?: number;
    tupInsertedPerSec?: number;
    tupUpdatedPerSec?: number;
    tupDeletedPerSec?: number;
  };
  charts: {
    connections: MetricSeries[];
    transactions: MetricSeries[];
    tuples: MetricSeries[];
    resources: MetricSeries[];
  };
};
