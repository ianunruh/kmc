import type { ClusterId } from "~/lib/types";
import { getClusterIdentity } from "~/lib/k8s/cluster-config.server";
import type { IpPoolConfig } from "~/lib/k8s/cluster-config.server";
import { getClusterClients } from "~/lib/k8s/clients.server";
import {
  addressFromIpv4Annotation,
  containsIpv4,
  countUsableHosts,
  firstFreeIpv4,
  formatIpv4,
  parseCidr,
  parseIpv4,
  usableHostRange,
  type ParsedCidr,
} from "./cidr";
import { IPAM_ANNOTATION_IPV4, IPAM_ANNOTATION_POOL } from "./constants";

export type { IpPoolConfig };

export type AllocatedIp = {
  poolId: string;
  address: string;
  prefix: number;
  /** address/prefix */
  cidrHost: string;
  gateway: string;
  dns: string[];
  /** cloud-init network-config match: interface name, or virtio driver */
  interfaceName?: string;
};

export type IpPoolUsage = {
  pool: IpPoolConfig;
  cidr: string;
  total: number;
  used: number;
  free: number;
  usedAddresses: string[];
};

type VmListItem = {
  metadata?: {
    name?: string;
    namespace?: string;
    annotations?: Record<string, string>;
  };
  spec?: {
    template?: {
      spec?: {
        networks?: Array<{
          name?: string;
          multus?: { networkName?: string };
        }>;
      };
    };
  };
};

type VmiListItem = {
  status?: {
    interfaces?: Array<{
      ipAddress?: string;
      ipAddresses?: string[];
    }>;
  };
};

/** Serialize allocate calls per cluster+pool within one process. */
const poolLocks = new Map<string, Promise<unknown>>();

async function withPoolLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = poolLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  poolLocks.set(
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

export function listIpPools(cluster: ClusterId): IpPoolConfig[] {
  return getClusterIdentity(cluster)?.ipPools ?? [];
}

export function findIpPoolForMultus(
  cluster: ClusterId,
  multusNetworkName: string,
): IpPoolConfig | null {
  const name = multusNetworkName.trim();
  if (!name) return null;
  const pools = listIpPools(cluster);
  for (const pool of pools) {
    if (multusNetworkMatches(pool.multusNetwork, name)) {
      return pool;
    }
  }
  return null;
}

/** NAD name may be `bridge-external` or `namespace/bridge-external`. */
export function multusNetworkMatches(poolNetwork: string, selected: string): boolean {
  const a = poolNetwork.trim();
  const b = selected.trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const aBase = a.includes("/") ? a.slice(a.lastIndexOf("/") + 1) : a;
  const bBase = b.includes("/") ? b.slice(b.lastIndexOf("/") + 1) : b;
  return aBase === bBase;
}

function buildExcludeSet(pool: IpPoolConfig, parsed: ParsedCidr): Set<string> {
  const exclude = new Set<string>();
  try {
    exclude.add(pool.gateway.trim());
  } catch {
    /* validated earlier */
  }
  for (const e of pool.exclude ?? []) {
    const addr = addressFromIpv4Annotation(e) ?? e.trim();
    if (addr) exclude.add(addr);
  }
  // Always treat network + broadcast as used for normal prefixes
  if (parsed.prefix <= 30) {
    exclude.add(formatIpv4(parsed.first));
    exclude.add(formatIpv4(parsed.last));
  }
  return exclude;
}

function validatePool(pool: IpPoolConfig): {
  parsed: ParsedCidr;
  range: ReturnType<typeof usableHostRange>;
  exclude: Set<string>;
} {
  const parsed = parseCidr(pool.cidr);
  parseIpv4(pool.gateway);
  if (!containsIpv4(parsed, pool.gateway)) {
    throw new Error(
      `IP pool "${pool.id}": gateway ${pool.gateway} is outside ${parsed.cidr}`,
    );
  }
  const range = usableHostRange(parsed, { start: pool.start, end: pool.end });
  const exclude = buildExcludeSet(pool, parsed);
  return { parsed, range, exclude };
}

async function listClusterVmsAndVmis(cluster: ClusterId): Promise<{
  vms: VmListItem[];
  vmis: VmiListItem[];
}> {
  const { custom } = getClusterClients(cluster);
  const [vmRes, vmiRes] = await Promise.all([
    custom.listClusterCustomObject({
      group: "kubevirt.io",
      version: "v1",
      plural: "virtualmachines",
    }) as Promise<{ items?: VmListItem[] }>,
    custom
      .listClusterCustomObject({
        group: "kubevirt.io",
        version: "v1",
        plural: "virtualmachineinstances",
      })
      .catch(() => ({ items: [] as VmiListItem[] })) as Promise<{
      items?: VmiListItem[];
    }>,
  ]);
  return {
    vms: vmRes.items ?? [],
    vmis: vmiRes.items ?? [],
  };
}

/**
 * Collect IPs considered in-use for a pool:
 * - kmc.io/ipv4 annotations on any VM (stopped VMs still hold the address)
 * - live VMI interface IPs that fall inside the pool CIDR
 */
export function collectUsedIpv4(
  pool: IpPoolConfig,
  parsed: ParsedCidr,
  vms: VmListItem[],
  vmis: VmiListItem[],
): Set<string> {
  const used = new Set<string>();

  for (const vm of vms) {
    const ann = vm.metadata?.annotations?.[IPAM_ANNOTATION_IPV4];
    if (!ann) continue;
    const addr = addressFromIpv4Annotation(ann);
    if (!addr) continue;
    try {
      if (containsIpv4(parsed, addr)) {
        used.add(addr);
      }
    } catch {
      /* skip bad annotation */
    }
  }

  for (const vmi of vmis) {
    for (const iface of vmi.status?.interfaces ?? []) {
      const ips = iface.ipAddresses ?? (iface.ipAddress ? [iface.ipAddress] : []);
      for (const raw of ips) {
        const addr = addressFromIpv4Annotation(raw);
        if (!addr) continue;
        try {
          if (containsIpv4(parsed, addr)) {
            used.add(addr);
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  // Gateway and configured exclusions count as used for free-count display
  void pool;
  return used;
}

export async function getIpPoolUsage(
  cluster: ClusterId,
  poolId: string,
): Promise<IpPoolUsage | null> {
  const pool = listIpPools(cluster).find((p) => p.id === poolId);
  if (!pool) return null;
  const { parsed, range, exclude } = validatePool(pool);
  const { vms, vmis } = await listClusterVmsAndVmis(cluster);
  const usedSet = collectUsedIpv4(pool, parsed, vms, vmis);
  for (const e of exclude) {
    if (containsIpv4(parsed, e)) usedSet.add(e);
  }

  const total = countUsableHosts(range);
  const usedInRange: string[] = [];
  for (let n = range.start; n <= range.end; n++) {
    const ip = formatIpv4(n);
    if (usedSet.has(ip) || exclude.has(ip)) {
      usedInRange.push(ip);
    }
  }

  // free = usable hosts not in used and not excluded
  let free = 0;
  for (let n = range.start; n <= range.end; n++) {
    const ip = formatIpv4(n);
    if (!usedSet.has(ip) && !exclude.has(ip)) free++;
  }

  return {
    pool,
    cidr: parsed.cidr,
    total,
    used: total - free,
    free,
    usedAddresses: usedInRange,
  };
}

export async function getIpPoolUsageForMultus(
  cluster: ClusterId,
  multusNetworkName: string,
): Promise<IpPoolUsage | null> {
  const pool = findIpPoolForMultus(cluster, multusNetworkName);
  if (!pool) return null;
  return getIpPoolUsage(cluster, pool.id);
}

/**
 * Allocate the next free IPv4 from the pool bound to this Multus NAD.
 * Returns null when the network has no configured pool.
 */
export async function allocateIpv4ForMultus(
  cluster: ClusterId,
  multusNetworkName: string,
): Promise<AllocatedIp | null> {
  const pool = findIpPoolForMultus(cluster, multusNetworkName);
  if (!pool) return null;

  const lockKey = `${cluster}::${pool.id}`;
  return withPoolLock(lockKey, async () => {
    const { parsed, range, exclude } = validatePool(pool);
    const { vms, vmis } = await listClusterVmsAndVmis(cluster);
    const used = collectUsedIpv4(pool, parsed, vms, vmis);

    const address = firstFreeIpv4(range, used, exclude);
    if (!address) {
      throw new Error(
        `IP pool "${pool.id}" (${parsed.cidr}) on cluster ${cluster} is exhausted`,
      );
    }

    return {
      poolId: pool.id,
      address,
      prefix: parsed.prefix,
      cidrHost: `${address}/${parsed.prefix}`,
      gateway: pool.gateway.trim(),
      dns: (pool.dns ?? []).map((d) => d.trim()).filter(Boolean),
      interfaceName: pool.interface?.trim() || undefined,
    };
  });
}

export function buildNetworkData(allocation: AllocatedIp): string {
  const ifaceKey = allocation.interfaceName ? "static0" : "net0";
  const matchBlock = allocation.interfaceName
    ? `    match:\n      name: "${allocation.interfaceName}"\n`
    : `    match:\n      driver: virtio_net\n`;

  const lines = [
    "version: 2",
    "ethernets:",
    `  ${ifaceKey}:`,
    ...matchBlock.trimEnd().split("\n"),
    "    dhcp4: false",
    "    addresses:",
    `      - ${allocation.cidrHost}`,
    "    routes:",
    "      - to: default",
    `        via: ${allocation.gateway}`,
  ];

  if (allocation.dns.length > 0) {
    lines.push("    nameservers:", "      addresses:");
    for (const d of allocation.dns) {
      lines.push(`        - ${d}`);
    }
  }

  return lines.join("\n") + "\n";
}

export function ipamAnnotations(allocation: AllocatedIp): Record<string, string> {
  return {
    [IPAM_ANNOTATION_IPV4]: allocation.cidrHost,
    [IPAM_ANNOTATION_POOL]: allocation.poolId,
  };
}
