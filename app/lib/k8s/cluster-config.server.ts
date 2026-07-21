import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ClusterId } from "~/lib/types";
import { getAuthMode } from "~/lib/auth/mode.server";

/** Scan-derived IPv4 pool bound to a Multus NAD (see app/lib/ipam). */
export type IpPoolConfig = {
  /** Stable id written to VM annotation kmc.io/ipam-pool */
  id: string;
  /**
   * Multus NetworkAttachmentDefinition name this pool serves.
   * Accepts `bridge-external` or `namespace/bridge-external`.
   */
  multusNetwork: string;
  /** e.g. 74.82.62.0/24 */
  cidr: string;
  gateway: string;
  dns?: string[];
  /** Extra addresses never allocated (routers, VIPs, etc.) */
  exclude?: string[];
  /** Optional allocation window within the CIDR */
  start?: string;
  end?: string;
  /**
   * Guest interface name for netplan match (e.g. enp1s0).
   * When omitted, match virtio_net driver.
   */
  interface?: string;
};

export type ClusterIdentity = {
  id: ClusterId;
  displayName: string;
  apiServer: string;
  caData?: string;
  caFile?: string;
  token?: string;
  tokenFile?: string;
  tokenEnv?: string;
  /** Base URL for Prometheus HTTP API (e.g. https://prometheus.example.com). */
  prometheusUrl?: string;
  /** Optional IPv4 pools for Multus bridge networks. */
  ipPools?: IpPoolConfig[];
};

type ClustersFile = {
  /**
   * Cluster used for app-level user prefs (SSH keys, etc.).
   * Defaults to the first entry in `clusters` when omitted.
   * Override with env `KMC_SETTINGS_CLUSTER`.
   */
  settingsCluster?: string;
  clusters?: Array<{
    id: string;
    displayName?: string;
    apiServer: string;
    caData?: string;
    caFile?: string;
    token?: string;
    tokenFile?: string;
    tokenEnv?: string;
    prometheusUrl?: string;
    ipPools?: Array<{
      id?: string;
      multusNetwork?: string;
      cidr?: string;
      gateway?: string;
      dns?: string[];
      exclude?: string[];
      start?: string;
      end?: string;
      interface?: string;
    }>;
  }>;
};

const DEFAULT_CONTEXTS = ["prod-sjc1", "homelab"];

let cached: {
  path: string;
  mtimeMs: number;
  identities: Map<string, ClusterIdentity>;
  /** From YAML top-level `settingsCluster`, if set. */
  settingsCluster?: string;
} | null = null;

function configPath(): string {
  return resolve(process.env.KMC_CLUSTERS_CONFIG ?? "config/clusters.yaml");
}

function loadFromYaml(path: string): {
  identities: Map<string, ClusterIdentity>;
  settingsCluster?: string;
} {
  if (!existsSync(path)) {
    return { identities: new Map() };
  }
  const text = readFileSync(path, "utf8");
  const doc = parseYaml(text) as ClustersFile;
  const map = new Map<string, ClusterIdentity>();
  for (const raw of doc.clusters ?? []) {
    if (!raw.id || !raw.apiServer) continue;
    map.set(raw.id, {
      id: raw.id,
      displayName: raw.displayName ?? raw.id,
      apiServer: raw.apiServer,
      caData: raw.caData,
      caFile: raw.caFile,
      token: raw.token,
      tokenFile: raw.tokenFile,
      tokenEnv: raw.tokenEnv,
      prometheusUrl: raw.prometheusUrl?.trim() || undefined,
      ipPools: parseIpPools(raw.ipPools, raw.id),
    });
  }
  const settingsCluster = doc.settingsCluster?.trim() || undefined;
  return { identities: map, settingsCluster };
}

function parseIpPools(
  raw:
    | Array<{
        id?: string;
        multusNetwork?: string;
        cidr?: string;
        gateway?: string;
        dns?: string[];
        exclude?: string[];
        start?: string;
        end?: string;
        interface?: string;
      }>
    | undefined,
  clusterId: string,
): IpPoolConfig[] | undefined {
  if (!raw?.length) return undefined;
  const pools: IpPoolConfig[] = [];
  const seenIds = new Set<string>();
  for (const p of raw) {
    const id = p.id?.trim();
    const multusNetwork = p.multusNetwork?.trim();
    const cidr = p.cidr?.trim();
    const gateway = p.gateway?.trim();
    if (!id || !multusNetwork || !cidr || !gateway) {
      throw new Error(
        `Cluster "${clusterId}": each ipPools entry needs id, multusNetwork, cidr, and gateway`,
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`Cluster "${clusterId}": duplicate ipPools id "${id}"`);
    }
    seenIds.add(id);
    pools.push({
      id,
      multusNetwork,
      cidr,
      gateway,
      dns: p.dns?.map((d) => d.trim()).filter(Boolean),
      exclude: p.exclude?.map((e) => e.trim()).filter(Boolean),
      start: p.start?.trim() || undefined,
      end: p.end?.trim() || undefined,
      interface: p.interface?.trim() || undefined,
    });
  }
  return pools;
}

/** Prometheus base URL for a cluster, if configured. */
export function getClusterPrometheusUrl(id: ClusterId): string | null {
  const url = getClusterIdentity(id)?.prometheusUrl?.trim();
  return url || null;
}

export function hasClusterPrometheus(id: ClusterId): boolean {
  return getClusterPrometheusUrl(id) != null;
}

function loadRegistry(): {
  identities: Map<string, ClusterIdentity>;
  settingsCluster?: string;
} {
  const path = configPath();
  let mtimeMs = 0;
  try {
    if (existsSync(path)) {
      mtimeMs = statSync(path).mtimeMs;
    }
  } catch {
    mtimeMs = 0;
  }
  if (cached && cached.path === path && cached.mtimeMs === mtimeMs) {
    return {
      identities: cached.identities,
      settingsCluster: cached.settingsCluster,
    };
  }
  const loaded = loadFromYaml(path);
  cached = {
    path,
    mtimeMs,
    identities: loaded.identities,
    settingsCluster: loaded.settingsCluster,
  };
  return loaded;
}

function getIdentities(): Map<string, ClusterIdentity> {
  return loadRegistry().identities;
}

/**
 * Cluster used for app-level user prefs (SSH keys ConfigMaps in kmc-system).
 *
 * Resolution order:
 * 1. `KMC_SETTINGS_CLUSTER` env
 * 2. top-level `settingsCluster` in clusters.yaml
 * 3. first registered cluster id
 */
export function getSettingsClusterId(): ClusterId {
  const env = process.env.KMC_SETTINGS_CLUSTER?.trim();
  if (env) return env;

  const { settingsCluster, identities } = loadRegistry();
  if (settingsCluster) return settingsCluster;

  const fromYaml = [...identities.keys()];
  if (fromYaml[0]) return fromYaml[0];

  const ids = listClusterIds();
  if (ids[0]) return ids[0];

  throw new Error(
    "No settings cluster configured. Set settingsCluster in clusters.yaml or KMC_SETTINGS_CLUSTER.",
  );
}

/** Prefer YAML registry; fall back to KMC_CONTEXTS / defaults for kubeconfig mode. */
export function listClusterIds(): ClusterId[] {
  const fromYaml = [...getIdentities().keys()];
  if (fromYaml.length > 0) return fromYaml;

  const env = process.env.KMC_CONTEXTS?.trim();
  if (env) {
    return env
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }
  return DEFAULT_CONTEXTS;
}

export function getClusterIdentity(id: ClusterId): ClusterIdentity | null {
  return getIdentities().get(id) ?? null;
}

export function resolveClusterToken(identity: ClusterIdentity): string {
  if (identity.token?.trim()) return identity.token.trim();
  if (identity.tokenEnv) {
    const v = process.env[identity.tokenEnv]?.trim();
    if (v) return v;
  }
  if (identity.tokenFile) {
    const path = resolve(identity.tokenFile);
    if (existsSync(path)) {
      return readFileSync(path, "utf8").trim();
    }
  }
  throw new Error(
    `No platform SA token for cluster "${identity.id}" (set token, tokenEnv, or tokenFile)`,
  );
}

export function requireClusterIdentity(id: ClusterId): ClusterIdentity {
  const identity = getClusterIdentity(id);
  if (!identity) {
    throw new Error(
      `Cluster "${id}" not found in ${configPath()}. Auth mode is ${getAuthMode()}.`,
    );
  }
  return identity;
}
