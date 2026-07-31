/**
 * ResourceQuota helpers for kmc-managed namespace capacity limits.
 *
 * Tracks the subset that matters for VM workloads:
 * - requests.cpu / requests.memory (virt-launcher pod resources)
 * - requests.storage + persistentvolumeclaims (DataVolume PVCs)
 * - count/virtualmachines.kubevirt.io (VM object count)
 */

import type {
  NamespaceQuota,
  NamespaceQuotaLimits,
  NamespaceQuotaResource,
  NamespaceQuotaUnitKind,
} from "~/lib/types";
import { quantityPercent } from "./quantity";

export const QUOTA_RESOURCE = {
  cpu: "requests.cpu",
  memory: "requests.memory",
  storage: "requests.storage",
  vms: "count/virtualmachines.kubevirt.io",
  pvcs: "persistentvolumeclaims",
} as const;

const RESOURCE_META: Record<
  string,
  { label: string; unitKind: NamespaceQuotaUnitKind; order: number }
> = {
  [QUOTA_RESOURCE.cpu]: { label: "CPU", unitKind: "cpu", order: 10 },
  "limits.cpu": { label: "CPU (limits)", unitKind: "cpu", order: 11 },
  [QUOTA_RESOURCE.memory]: { label: "Memory", unitKind: "memory", order: 20 },
  "limits.memory": { label: "Memory (limits)", unitKind: "memory", order: 21 },
  [QUOTA_RESOURCE.storage]: { label: "Storage", unitKind: "storage", order: 30 },
  [QUOTA_RESOURCE.vms]: { label: "Virtual machines", unitKind: "count", order: 40 },
  [QUOTA_RESOURCE.pvcs]: { label: "Persistent volume claims", unitKind: "count", order: 50 },
  pods: { label: "Pods", unitKind: "count", order: 60 },
  services: { label: "Services", unitKind: "count", order: 70 },
  "count/datavolumes.cdi.kubevirt.io": {
    label: "DataVolumes",
    unitKind: "count",
    order: 55,
  },
};

export type KubeResourceQuota = {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    resourceVersion?: string;
  };
  spec?: {
    hard?: Record<string, string>;
  };
  status?: {
    hard?: Record<string, string>;
    used?: Record<string, string>;
  };
};

function metaFor(name: string): {
  label: string;
  unitKind: NamespaceQuotaUnitKind;
  order: number;
} {
  return (
    RESOURCE_META[name] ?? {
      label: name,
      unitKind: "other" as const,
      order: 1000,
    }
  );
}

/** Build ordered used/hard rows for capacity UI. */
export function buildQuotaResources(
  hard: Record<string, string>,
  used: Record<string, string>,
): NamespaceQuotaResource[] {
  const keys = new Set([...Object.keys(hard), ...Object.keys(used)]);
  const rows: Array<NamespaceQuotaResource & { order: number }> = [];
  for (const name of keys) {
    const { label, unitKind, order } = metaFor(name);
    const h = hard[name];
    const u = used[name];
    rows.push({
      name,
      label,
      hard: h,
      used: u,
      percent: quantityPercent(u, h),
      unitKind,
      order,
    });
  }
  rows.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name);
  });
  return rows.map(({ name, label, hard: h, used: u, percent, unitKind }) => ({
    name,
    label,
    hard: h,
    used: u,
    percent,
    unitKind,
  }));
}

/** Extract friendly limits from a hard map (for edit forms). */
export function limitsFromHard(hard: Record<string, string>): NamespaceQuotaLimits {
  const limits: NamespaceQuotaLimits = {};
  if (hard[QUOTA_RESOURCE.cpu]) limits.cpu = hard[QUOTA_RESOURCE.cpu];
  if (hard[QUOTA_RESOURCE.memory]) limits.memory = hard[QUOTA_RESOURCE.memory];
  if (hard[QUOTA_RESOURCE.storage]) limits.storage = hard[QUOTA_RESOURCE.storage];
  const vms = hard[QUOTA_RESOURCE.vms];
  if (vms != null && vms !== "") {
    const n = Number(vms);
    if (Number.isFinite(n) && n >= 0) limits.vms = Math.floor(n);
  }
  const pvcs = hard[QUOTA_RESOURCE.pvcs];
  if (pvcs != null && pvcs !== "") {
    const n = Number(pvcs);
    if (Number.isFinite(n) && n >= 0) limits.pvcs = Math.floor(n);
  }
  return limits;
}

/** Convert friendly limits into a ResourceQuota hard map. Omits empty fields. */
export function hardFromLimits(limits: NamespaceQuotaLimits): Record<string, string> {
  const hard: Record<string, string> = {};
  const cpu = limits.cpu?.trim();
  if (cpu) hard[QUOTA_RESOURCE.cpu] = cpu;
  const memory = limits.memory?.trim();
  if (memory) hard[QUOTA_RESOURCE.memory] = memory;
  const storage = limits.storage?.trim();
  if (storage) hard[QUOTA_RESOURCE.storage] = storage;
  if (limits.vms != null && Number.isFinite(limits.vms) && limits.vms >= 0) {
    hard[QUOTA_RESOURCE.vms] = String(Math.floor(limits.vms));
  }
  if (limits.pvcs != null && Number.isFinite(limits.pvcs) && limits.pvcs >= 0) {
    hard[QUOTA_RESOURCE.pvcs] = String(Math.floor(limits.pvcs));
  }
  return hard;
}

export function hasAnyLimit(limits: NamespaceQuotaLimits): boolean {
  return Object.keys(hardFromLimits(limits)).length > 0;
}

export function mapResourceQuota(
  rq: KubeResourceQuota,
  managedByKmc: boolean,
): NamespaceQuota {
  const hard = {
    ...(rq.spec?.hard ?? {}),
    ...(rq.status?.hard ?? {}),
  };
  // Prefer status.hard (enforced) when present for display values of hard keys.
  const displayHard = rq.status?.hard ?? rq.spec?.hard ?? {};
  const used = rq.status?.used ?? {};
  const mergedHard = Object.keys(displayHard).length > 0 ? displayHard : hard;
  return {
    name: rq.metadata?.name ?? "unknown",
    managedByKmc,
    hard: mergedHard,
    used,
    resources: buildQuotaResources(mergedHard, used),
    limits: limitsFromHard(rq.spec?.hard ?? mergedHard),
  };
}

/** Progress bar color from usage percent. */
export function capacityColor(percent: number | null): string {
  if (percent == null) return "gray";
  if (percent >= 100) return "red";
  if (percent >= 85) return "orange";
  if (percent >= 70) return "yellow";
  return "teal";
}
