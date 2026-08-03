import type { ClusterId } from "~/lib/types";
import type { VlanPoolConfig } from "~/lib/k8s/cluster-config.server";
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
 * Cluster-scoped VLANPool CRs (operator-applied). Empty when none exist or the
 * API is missing/forbidden. No clusters.yaml fallback — apply examples under
 * deploy/controller/examples/vlanpool.yaml.
 */
export async function listVlanPools(cluster: ClusterId): Promise<VlanPoolConfig[]> {
  try {
    const items = await listClusterCustomObjects<VlanPoolCr>(
      cluster,
      PLURAL_VLAN_POOLS,
    );
    return items
      .map(vlanPoolConfigFromCr)
      .filter((p): p is VlanPoolConfig => p != null);
  } catch (err) {
    if (!isNotFoundError(err) && !isForbiddenError(err)) {
      console.error(
        `listVlanPools(${cluster}) CR:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return [];
  }
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
