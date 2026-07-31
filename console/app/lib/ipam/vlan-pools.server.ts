import type { ClusterId } from "~/lib/types";
import {
  getClusterIdentity,
  type VlanPoolConfig,
} from "~/lib/k8s/cluster-config.server";
import { getClusterClients } from "~/lib/k8s/clients.server";
import {
  KMC_LABEL_RESOURCE,
  KMC_LABEL_VLAN,
  KMC_RESOURCE_VPC,
  KMC_VPC_LABEL_SELECTOR,
} from "~/lib/k8s/constants";

export type { VlanPoolConfig };

export type VlanPoolUsage = {
  pool: VlanPoolConfig;
  total: number;
  used: number;
  free: number;
  usedVlans: number[];
};

type NadListItem = {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
};

/** Serialize VLAN allocate calls per cluster+pool within one process. */
const vlanLocks = new Map<string, Promise<unknown>>();

async function withVlanLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = vlanLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vlanLocks.set(
    key,
    prev.then(() => gate).catch(() => gate),
  );
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

export function listVlanPools(cluster: ClusterId): VlanPoolConfig[] {
  return getClusterIdentity(cluster)?.vlanPools ?? [];
}

export function getVlanPool(
  cluster: ClusterId,
  poolId?: string,
): VlanPoolConfig | null {
  const pools = listVlanPools(cluster);
  if (pools.length === 0) return null;
  if (!poolId?.trim()) return pools[0] ?? null;
  return pools.find((p) => p.id === poolId.trim()) ?? null;
}

export function clusterHasVlanPools(cluster: ClusterId): boolean {
  return listVlanPools(cluster).length > 0;
}

/** Pure: used set for a pool given discovered VLAN ids. */
export function collectUsedVlans(
  pool: VlanPoolConfig,
  discovered: Iterable<number>,
): Set<number> {
  const used = new Set<number>();
  for (const v of pool.exclude ?? []) {
    if (v >= pool.start && v <= pool.end) used.add(v);
  }
  for (const v of discovered) {
    if (Number.isInteger(v) && v >= pool.start && v <= pool.end) {
      used.add(v);
    }
  }
  return used;
}

/** Pure: first free VLAN in range, or null if exhausted. */
export function firstFreeVlan(
  pool: VlanPoolConfig,
  used: ReadonlySet<number>,
): number | null {
  for (let v = pool.start; v <= pool.end; v++) {
    if (!used.has(v)) return v;
  }
  return null;
}

export function parseVlanLabel(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < 1 || n > 4094) return null;
  return n;
}

async function listVpcNads(cluster: ClusterId): Promise<NadListItem[]> {
  const { custom } = getClusterClients(cluster);
  try {
    const res = (await custom.listClusterCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      plural: "network-attachment-definitions",
      labelSelector: KMC_VPC_LABEL_SELECTOR,
    })) as { items?: NadListItem[] };
    return res.items ?? [];
  } catch {
    // Fall back without label selector (some aggregators reject field/label)
    const res = (await custom.listClusterCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      plural: "network-attachment-definitions",
    })) as { items?: NadListItem[] };
    return (res.items ?? []).filter(
      (item) =>
        item.metadata?.labels?.[KMC_LABEL_RESOURCE] === KMC_RESOURCE_VPC,
    );
  }
}

export function vlansFromNads(nads: NadListItem[]): number[] {
  const out: number[] = [];
  for (const nad of nads) {
    const v = parseVlanLabel(nad.metadata?.labels?.[KMC_LABEL_VLAN]);
    if (v != null) out.push(v);
  }
  return out;
}

export async function getVlanPoolUsage(
  cluster: ClusterId,
  poolId?: string,
): Promise<VlanPoolUsage | null> {
  const pool = getVlanPool(cluster, poolId);
  if (!pool) return null;
  const nads = await listVpcNads(cluster);
  const used = collectUsedVlans(pool, vlansFromNads(nads));
  const total = pool.end - pool.start + 1;
  const usedVlans = Array.from(used).sort((a, b) => a - b);
  return {
    pool,
    total,
    used: used.size,
    free: total - used.size,
    usedVlans,
  };
}

/**
 * Allocate the next free VLAN from a cluster vlan pool.
 * Serializes per process; cluster NAD labels are the source of truth.
 */
export async function allocateVlan(
  cluster: ClusterId,
  poolId?: string,
): Promise<{ pool: VlanPoolConfig; vlan: number }> {
  const pool = getVlanPool(cluster, poolId);
  if (!pool) {
    throw new Error(
      `Cluster "${cluster}" has no vlanPools configured (add vlanPools to clusters.yaml)`,
    );
  }

  const lockKey = `${cluster}::vlan::${pool.id}`;
  return withVlanLock(lockKey, async () => {
    const nads = await listVpcNads(cluster);
    const used = collectUsedVlans(pool, vlansFromNads(nads));
    const vlan = firstFreeVlan(pool, used);
    if (vlan == null) {
      throw new Error(
        `VLAN pool "${pool.id}" (${pool.start}–${pool.end}) on cluster ${cluster} is exhausted`,
      );
    }
    return { pool, vlan };
  });
}
