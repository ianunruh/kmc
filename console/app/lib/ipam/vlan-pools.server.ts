import type { ClusterId } from "~/lib/types";
import {
  getClusterIdentity,
  type VlanPoolConfig,
} from "~/lib/k8s/cluster-config.server";
import {
  isForbiddenError,
  isNotFoundError,
  listClusterCustomObjects,
  PLURAL_VLAN_POOLS,
  type VlanPoolCr,
} from "~/lib/k8s/networking-cr.server";

export type { VlanPoolConfig };

export type VlanPoolUsage = {
  pool: VlanPoolConfig;
  total: number;
  used: number;
  free: number;
  usedVlans: number[];
};

function vlanPoolConfigFromCr(cr: VlanPoolCr): VlanPoolConfig | null {
  const id = cr.metadata?.name?.trim();
  const start = cr.spec?.start;
  const end = cr.spec?.end;
  const bridge = cr.spec?.bridge?.trim();
  if (!id || start == null || end == null || !bridge) return null;
  return {
    id,
    start,
    end,
    bridge,
    dns: (cr.spec?.dns ?? []).map((d) => d.trim()).filter(Boolean),
    exclude: (cr.spec?.exclude ?? []).filter((v) => Number.isInteger(v)),
  };
}

/**
 * Cluster-scoped VLANPool CRs (preferred). Falls back to clusters.yaml vlanPools
 * when CRs are empty/unavailable.
 */
export async function listVlanPools(cluster: ClusterId): Promise<VlanPoolConfig[]> {
  try {
    const items = await listClusterCustomObjects<VlanPoolCr>(
      cluster,
      PLURAL_VLAN_POOLS,
    );
    const fromCr = items
      .map(vlanPoolConfigFromCr)
      .filter((p): p is VlanPoolConfig => p != null);
    if (fromCr.length > 0) return fromCr;
  } catch (err) {
    if (!isNotFoundError(err) && !isForbiddenError(err)) {
      console.error(
        `listVlanPools(${cluster}) CR:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return getClusterIdentity(cluster)?.vlanPools ?? [];
}

export async function getVlanPool(
  cluster: ClusterId,
  poolId?: string,
): Promise<VlanPoolConfig | null> {
  const pools = await listVlanPools(cluster);
  if (pools.length === 0) return null;
  if (!poolId?.trim()) return pools[0] ?? null;
  return pools.find((p) => p.id === poolId.trim()) ?? null;
}

export async function clusterHasVlanPools(cluster: ClusterId): Promise<boolean> {
  return (await listVlanPools(cluster)).length > 0;
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
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 4094) return null;
  return n;
}
