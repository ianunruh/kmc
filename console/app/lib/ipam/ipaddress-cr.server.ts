/**
 * Console client for kmc.ianunruh.com IPAddress claims.
 * Create is the multi-replica lease (409 on concurrent claim of same address name).
 */
import type { ClusterId } from "~/lib/types";
import type { IpPoolConfig } from "~/lib/k8s/cluster-config.server";
import { getClusterClients } from "~/lib/k8s/clients.server";
import {
  KMC_LABEL_NAMESPACE,
  KMC_MANAGED_BY,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import { formatError } from "~/lib/errors";
import { addressFromIpv4Annotation } from "./cidr";

export const IPADDRESS_GROUP = "kmc.ianunruh.com";
export const IPADDRESS_VERSION = "v1alpha1";
export const IPADDRESS_PLURAL = "ipaddresses";

export const IPADDRESS_LABEL_ADDRESS = `${KMC_LABEL_NAMESPACE}/address`;
export const IPADDRESS_LABEL_POOL = `${KMC_LABEL_NAMESPACE}/pool`;

export type IpAddressClaimRef = {
  apiVersion?: string;
  kind?: string;
  name: string;
  namespace?: string;
};

export type IpAddressPoolRef = {
  kind: string;
  name: string;
};

export type IpAddressInterface = {
  mac?: string;
  hostname?: string;
};

/** DNS-1123 object name from IPv4 (10.40.1.20 → 10-40-1-20). */
export function ipAddressObjectName(address: string): string {
  return address.trim().replaceAll(".", "-");
}

/**
 * Map console IpPoolConfig to CR poolRef.
 * Static pools → kind IPPool / id.
 * Dynamic VPC (`vpc:ns/name`) → kind VPC / name.
 */
export function poolRefFromConfig(pool: IpPoolConfig): IpAddressPoolRef {
  if (pool.id.startsWith("vpc:")) {
    const rest = pool.id.slice("vpc:".length);
    const slash = rest.indexOf("/");
    const name = slash > 0 ? rest.slice(slash + 1) : rest;
    return { kind: "VPC", name: name || pool.id };
  }
  return { kind: "IPPool", name: pool.id };
}

function apiStatusCode(err: unknown): number | undefined {
  const e = err as {
    statusCode?: number;
    code?: number | string;
    response?: { statusCode?: number; status?: number };
  };
  const n =
    e?.statusCode ??
    e?.response?.statusCode ??
    e?.response?.status ??
    (typeof e?.code === "number" ? e.code : undefined);
  if (typeof n === "number" && n > 0) return n;

  const msg = formatError(err);
  const httpCode = msg.match(/HTTP-Code:\s*(\d+)/i);
  if (httpCode) {
    const parsed = Number(httpCode[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  const jsonCode = msg.match(/"code"\s*:\s*(\d{3})/);
  if (jsonCode) {
    const parsed = Number(jsonCode[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function isIpAddressAlreadyExists(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  if (message.includes("already exists") || message.includes("alreadyexists")) {
    return true;
  }
  return apiStatusCode(err) === 409;
}

export function isIpAddressNotFound(err: unknown): boolean {
  if (apiStatusCode(err) === 404) return true;
  const message = formatError(err).toLowerCase();
  return message.includes("not found");
}

export function isIpAddressForbidden(err: unknown): boolean {
  const code = apiStatusCode(err);
  if (code === 403) return true;
  const message = formatError(err).toLowerCase();
  return message.includes("forbidden") || message.includes("is forbidden");
}

type IpAddressListItem = {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    address?: string;
    claimRef?: { name?: string; kind?: string; namespace?: string };
    interface?: { mac?: string; hostname?: string };
    poolRef?: { kind?: string; name?: string };
  };
};

export type CreateIpAddressClaimInput = {
  cluster: ClusterId;
  namespace: string;
  address: string;
  prefixLength: number;
  pool: IpPoolConfig;
  claim?: IpAddressClaimRef;
  /** Guest NIC binding for DHCP lease projection (Router controller). */
  interface?: IpAddressInterface;
};

/**
 * Create an IPAddress claim. Throws on conflict (caller retries next free).
 * Does not wait for controller Bound status — create success is the lease.
 */
export async function createIpAddressClaim(
  input: CreateIpAddressClaimInput,
): Promise<void> {
  const address = input.address.trim();
  if (!address) throw new Error("address is required for IPAddress claim");
  const ns = input.namespace.trim();
  if (!ns) throw new Error("namespace is required for IPAddress claim");

  const name = ipAddressObjectName(address);
  const poolRef = poolRefFromConfig(input.pool);
  const claimNs = input.claim?.namespace?.trim() || ns;
  const claimName = input.claim?.name?.trim();
  const mac = input.interface?.mac?.trim().toLowerCase();
  const hostname = input.interface?.hostname?.trim();

  const body = {
    apiVersion: `${IPADDRESS_GROUP}/${IPADDRESS_VERSION}`,
    kind: "IPAddress",
    metadata: {
      name,
      namespace: ns,
      labels: {
        [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
        [IPADDRESS_LABEL_ADDRESS]: address,
        [IPADDRESS_LABEL_POOL]: poolRef.name,
      },
    },
    spec: {
      address,
      prefixLength: input.prefixLength,
      poolRef,
      ...(claimName
        ? {
            claimRef: {
              apiVersion: input.claim?.apiVersion?.trim() || "kubevirt.io/v1",
              kind: input.claim?.kind?.trim() || "VirtualMachine",
              namespace: claimNs,
              name: claimName,
            },
          }
        : {}),
      ...(mac || hostname
        ? {
            interface: {
              ...(mac ? { mac } : {}),
              ...(hostname ? { hostname } : {}),
            },
          }
        : {}),
    },
  };

  const { custom } = getClusterClients(input.cluster);
  try {
    await custom.createNamespacedCustomObject({
      group: IPADDRESS_GROUP,
      version: IPADDRESS_VERSION,
      namespace: ns,
      plural: IPADDRESS_PLURAL,
      body,
    });
  } catch (err) {
    if (isIpAddressAlreadyExists(err)) throw err;
    const hint = isIpAddressForbidden(err)
      ? " (need create on ipaddresses.kmc.ianunruh.com — see deploy/controller RBAC example)"
      : "";
    throw new Error(
      `Failed to create IPAddress ${ns}/${name} for ${address}: ${formatError(err)}${hint}`,
      { cause: err },
    );
  }
}

/** Delete claim by address; ignore not found. */
export async function deleteIpAddressClaim(
  cluster: ClusterId,
  namespace: string,
  address: string,
): Promise<void> {
  const addr = addressFromIpv4Annotation(address) ?? address.trim();
  if (!addr) return;
  const ns = namespace.trim();
  if (!ns) return;
  const name = ipAddressObjectName(addr);
  const { custom } = getClusterClients(cluster);
  try {
    await custom.deleteNamespacedCustomObject({
      group: IPADDRESS_GROUP,
      version: IPADDRESS_VERSION,
      namespace: ns,
      plural: IPADDRESS_PLURAL,
      name,
    });
  } catch (err) {
    if (isIpAddressNotFound(err)) return;
    console.error(
      `deleteIpAddressClaim ${ns}/${name}:`,
      formatError(err),
    );
  }
}

/** Best-effort release a list of addresses (createVm rollback, etc.). */
export async function releaseIpAddressClaims(
  cluster: ClusterId,
  namespace: string,
  addresses: string[],
): Promise<void> {
  for (const a of addresses) {
    await deleteIpAddressClaim(cluster, namespace, a);
  }
}

/**
 * Addresses held by IPAddress CRs (for used-set merge).
 * - VPC pools: list in `namespace`
 * - Static pools: prefer cluster-wide list; on 403 fall back to namespace
 */
export async function listIpAddressClaimAddresses(opts: {
  cluster: ClusterId;
  namespace: string;
  /** When true (static IPPool CRs), try cluster-scoped list first. */
  clusterWide?: boolean;
}): Promise<string[]> {
  const { custom } = getClusterClients(opts.cluster);
  const ns = opts.namespace.trim();
  const out: string[] = [];

  const collect = (items: IpAddressListItem[] | undefined) => {
    for (const item of items ?? []) {
      const addr =
        item.spec?.address?.trim() ||
        item.metadata?.name?.replaceAll("-", "."); // weak fallback
      const normalized = addressFromIpv4Annotation(addr ?? "") ?? addr;
      if (normalized) out.push(normalized);
    }
  };

  if (opts.clusterWide) {
    try {
      const res = (await custom.listClusterCustomObject({
        group: IPADDRESS_GROUP,
        version: IPADDRESS_VERSION,
        plural: IPADDRESS_PLURAL,
      })) as { items?: IpAddressListItem[] };
      collect(res.items);
      return out;
    } catch (err) {
      if (!isIpAddressForbidden(err) && !isIpAddressNotFound(err)) {
        console.error(
          "listIpAddressClaimAddresses cluster:",
          formatError(err),
        );
      }
      // fall through to namespaced list
    }
  }

  if (!ns) return out;
  try {
    const res = (await custom.listNamespacedCustomObject({
      group: IPADDRESS_GROUP,
      version: IPADDRESS_VERSION,
      namespace: ns,
      plural: IPADDRESS_PLURAL,
    })) as { items?: IpAddressListItem[] };
    collect(res.items);
  } catch (err) {
    if (!isIpAddressNotFound(err)) {
      console.error(
        `listIpAddressClaimAddresses ${ns}:`,
        formatError(err),
      );
    }
  }
  return out;
}

/**
 * Free claims for a deleted VM: by explicit addresses and/or claimRef match.
 */
export async function deleteIpAddressClaimsForVm(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
  addresses?: string[],
): Promise<void> {
  const ns = namespace.trim();
  const name = vmName.trim();
  if (!ns || !name) return;

  const seen = new Set<string>();
  for (const a of addresses ?? []) {
    const addr = addressFromIpv4Annotation(a) ?? a.trim();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    await deleteIpAddressClaim(cluster, ns, addr);
  }

  // Also drop any CR that still points at this VM (annotation missing / partial).
  try {
    const { custom } = getClusterClients(cluster);
    const res = (await custom.listNamespacedCustomObject({
      group: IPADDRESS_GROUP,
      version: IPADDRESS_VERSION,
      namespace: ns,
      plural: IPADDRESS_PLURAL,
    })) as { items?: IpAddressListItem[] };
    for (const item of res.items ?? []) {
      const claim = item.spec?.claimRef;
      if (!claim?.name || claim.name !== name) continue;
      if (claim.namespace && claim.namespace !== ns) continue;
      const addr =
        item.spec?.address?.trim() ||
        (item.metadata?.name
          ? item.metadata.name.replaceAll("-", ".")
          : "");
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      await deleteIpAddressClaim(cluster, ns, addr);
    }
  } catch (err) {
    if (!isIpAddressNotFound(err)) {
      console.error(
        `deleteIpAddressClaimsForVm list ${ns}/${name}:`,
        formatError(err),
      );
    }
  }
}
