import type { ClusterId } from "~/lib/types";
import { getClusterIdentity } from "~/lib/k8s/cluster-config.server";
import type { IpPoolConfig } from "~/lib/k8s/cluster-config.server";
import { getClusterClients } from "~/lib/k8s/clients.server";
import {
  KMC_ANN_CIDR,
  KMC_ANN_DNS,
  KMC_ANN_GATEWAY,
  KMC_LABEL_RESOURCE,
  KMC_RESOURCE_VPC,
} from "~/lib/k8s/constants";
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
  /** When omitted, netplan gets addresses only (no default route). */
  gateway?: string;
  dns: string[];
  /** cloud-init network-config match: interface name (pool.interface) */
  interfaceName?: string;
  /**
   * Guest NIC MAC set on the KubeVirt interface and used for netplan match.
   * Preferred over virtio driver match when multi-attach or when set.
   */
  macAddress?: string;
  /** KubeVirt network/interface name (e.g. default, net0) — netplan ethernet key */
  networkName?: string;
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

/**
 * Static pools first; then VPC NAD annotations when `namespace` is known.
 */
export async function resolveIpPoolForMultus(
  cluster: ClusterId,
  multusNetworkName: string,
  namespace?: string,
): Promise<IpPoolConfig | null> {
  const staticPool = findIpPoolForMultus(cluster, multusNetworkName);
  if (staticPool) return staticPool;

  const name = multusNetworkName.trim();
  if (!name || !namespace?.trim()) return null;

  const ref = parseMultusNetworkRef(name, namespace);
  const nad = await loadNamespacedNad(cluster, ref.namespace, ref.name);
  if (!nad) return null;
  return ipPoolFromVpcNad(nad, ref.namespace);
}

/** Resolve by dynamic pool id `vpc:namespace/name`. */
export async function resolveIpPoolById(
  cluster: ClusterId,
  poolId: string,
): Promise<IpPoolConfig | null> {
  const staticPool = listIpPools(cluster).find((p) => p.id === poolId);
  if (staticPool) return staticPool;

  if (!poolId.startsWith("vpc:")) return null;
  const rest = poolId.slice("vpc:".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const ns = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  const nad = await loadNamespacedNad(cluster, ns, name);
  if (!nad) return null;
  return ipPoolFromVpcNad(nad, ns);
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
  const gw = pool.gateway?.trim();
  if (gw) {
    try {
      exclude.add(gw);
    } catch {
      /* validated earlier */
    }
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
  const gw = pool.gateway?.trim();
  if (gw) {
    parseIpv4(gw);
    if (!containsIpv4(parsed, gw)) {
      throw new Error(
        `IP pool "${pool.id}": gateway ${gw} is outside ${parsed.cidr}`,
      );
    }
  }
  const range = usableHostRange(parsed, { start: pool.start, end: pool.end });
  const exclude = buildExcludeSet(pool, parsed);
  return { parsed, range, exclude };
}

type NadForPool = {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
};

/** Build an IpPoolConfig from a VPC NAD when it has a cidr annotation. */
export function ipPoolFromVpcNad(
  nad: NadForPool,
  namespaceHint?: string,
): IpPoolConfig | null {
  const labels = nad.metadata?.labels ?? {};
  const ann = nad.metadata?.annotations ?? {};
  if (labels[KMC_LABEL_RESOURCE] !== KMC_RESOURCE_VPC) return null;
  const cidr = ann[KMC_ANN_CIDR]?.trim();
  if (!cidr) return null;
  const name = nad.metadata?.name?.trim();
  if (!name) return null;
  const ns = nad.metadata?.namespace?.trim() || namespaceHint?.trim() || "";
  const gateway = ann[KMC_ANN_GATEWAY]?.trim() || undefined;
  const dns = (ann[KMC_ANN_DNS] ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  return {
    id: `vpc:${ns}/${name}`,
    multusNetwork: name,
    cidr,
    gateway,
    dns: dns.length > 0 ? dns : undefined,
  };
}

async function loadNamespacedNad(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<NadForPool | null> {
  const { custom } = getClusterClients(cluster);
  try {
    return (await custom.getNamespacedCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      namespace,
      plural: "network-attachment-definitions",
      name,
    })) as NadForPool;
  } catch {
    return null;
  }
}

/**
 * Resolve Multus network name relative to a VM namespace.
 * Accepts `bridge-external` or `other-ns/bridge-external`.
 */
export function parseMultusNetworkRef(
  multusNetworkName: string,
  defaultNamespace: string,
): { namespace: string; name: string } {
  const raw = multusNetworkName.trim();
  const slash = raw.indexOf("/");
  if (slash > 0) {
    return {
      namespace: raw.slice(0, slash),
      name: raw.slice(slash + 1),
    };
  }
  return { namespace: defaultNamespace, name: raw };
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
 * Parse kmc.ianunruh.com/ipv4 — one address or comma-separated multi-attach list.
 */
export function parseIpv4AnnotationList(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(",")) {
    const addr = addressFromIpv4Annotation(part.trim());
    if (addr) out.push(addr);
  }
  return out;
}

/**
 * Collect IPs considered in-use for a pool:
 * - kmc.ianunruh.com/ipv4 annotations on any VM (stopped VMs still hold the address;
 *   multi-attach stores comma-separated addresses)
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
    for (const addr of parseIpv4AnnotationList(ann)) {
      try {
        if (containsIpv4(parsed, addr)) {
          used.add(addr);
        }
      } catch {
        /* skip bad annotation */
      }
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

export async function getIpPoolUsageForConfig(
  cluster: ClusterId,
  pool: IpPoolConfig,
): Promise<IpPoolUsage> {
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

export async function getIpPoolUsage(
  cluster: ClusterId,
  poolId: string,
): Promise<IpPoolUsage | null> {
  const pool = await resolveIpPoolById(cluster, poolId);
  if (!pool) return null;
  return getIpPoolUsageForConfig(cluster, pool);
}

export async function getIpPoolUsageForMultus(
  cluster: ClusterId,
  multusNetworkName: string,
  namespace?: string,
): Promise<IpPoolUsage | null> {
  const pool = await resolveIpPoolForMultus(
    cluster,
    multusNetworkName,
    namespace,
  );
  if (!pool) return null;
  return getIpPoolUsageForConfig(cluster, pool);
}

/**
 * Allocate the next free IPv4 from the pool bound to this Multus NAD.
 * Returns null when the network has no configured pool.
 * Pass `namespace` so self-service VPC NADs (dynamic pools) can be resolved.
 * `extraUsed` reserves addresses already chosen in the same multi-attach create
 * (before the VM annotation exists for the cluster scan).
 */
export async function allocateIpv4ForMultus(
  cluster: ClusterId,
  multusNetworkName: string,
  namespace?: string,
  opts?: { extraUsed?: string[] },
): Promise<AllocatedIp | null> {
  const pool = await resolveIpPoolForMultus(
    cluster,
    multusNetworkName,
    namespace,
  );
  if (!pool) return null;

  const lockKey = `${cluster}::${pool.id}`;
  return withPoolLock(lockKey, async () => {
    // Re-resolve inside the lock so concurrent creates see fresh used set;
    // pool config is stable for the NAD.
    const { parsed, range, exclude } = validatePool(pool);
    const { vms, vmis } = await listClusterVmsAndVmis(cluster);
    const used = collectUsedIpv4(pool, parsed, vms, vmis);
    for (const a of opts?.extraUsed ?? []) {
      const addr = addressFromIpv4Annotation(a) ?? a.trim();
      if (addr) used.add(addr);
    }

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
      gateway: pool.gateway?.trim() || undefined,
      dns: (pool.dns ?? []).map((d) => d.trim()).filter(Boolean),
      interfaceName: pool.interface?.trim() || undefined,
    };
  });
}

/**
 * Locally administered unicast MAC for a KubeVirt interface (stable for cloud-init match).
 */
export function generateLocalMacAddress(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  // Unicast (bit0 clear) + locally administered (bit1 set)
  bytes[0] = (bytes[0]! & 0xfe) | 0x02;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(":");
}

/**
 * Prefer the first allocation that has a gateway (default route); else the first.
 */
export function pickPrimaryAllocation(
  allocations: AllocatedIp[],
): AllocatedIp | undefined {
  return allocations.find((a) => a.gateway?.trim()) ?? allocations[0];
}

function ethernetKeyFor(allocation: AllocatedIp, index: number): string {
  if (allocation.interfaceName) return `static${index}`;
  if (allocation.networkName) return allocation.networkName;
  return `net${index}`;
}

function matchLinesFor(allocation: AllocatedIp): string[] {
  if (allocation.interfaceName) {
    return [`    match:`, `      name: "${allocation.interfaceName}"`];
  }
  if (allocation.macAddress) {
    return [
      `    match:`,
      `      macaddress: "${allocation.macAddress.toLowerCase()}"`,
    ];
  }
  // Single-NIC fallback when no MAC was stamped (legacy behavior)
  return [`    match:`, `      driver: virtio_net`];
}

/**
 * cloud-init network-config (netplan) for one or more Multus IPAM allocations.
 * At most one default route is installed (primary = first with gateway, else first).
 */
export function buildNetworkData(allocations: AllocatedIp | AllocatedIp[]): string {
  const list = Array.isArray(allocations) ? allocations : [allocations];
  if (list.length === 0) {
    throw new Error("buildNetworkData requires at least one allocation");
  }

  const primary = pickPrimaryAllocation(list);
  const lines = ["version: 2", "ethernets:"];

  list.forEach((allocation, index) => {
    const key = ethernetKeyFor(allocation, index);
    lines.push(`  ${key}:`);
    lines.push(...matchLinesFor(allocation));
    lines.push("    dhcp4: false", "    addresses:", `      - ${allocation.cidrHost}`);

    const gateway = allocation.gateway?.trim();
    if (gateway && allocation === primary) {
      lines.push("    routes:", "      - to: default", `        via: ${gateway}`);
    }

    if (allocation.dns.length > 0) {
      lines.push("    nameservers:", "      addresses:");
      for (const d of allocation.dns) {
        lines.push(`        - ${d}`);
      }
    }
  });

  return lines.join("\n") + "\n";
}

export function ipamAnnotations(
  allocations: AllocatedIp | AllocatedIp[],
): Record<string, string> {
  const list = Array.isArray(allocations) ? allocations : [allocations];
  if (list.length === 0) return {};
  return {
    [IPAM_ANNOTATION_IPV4]: list.map((a) => a.cidrHost).join(","),
    [IPAM_ANNOTATION_POOL]: list.map((a) => a.poolId).join(","),
  };
}
