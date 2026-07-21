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
