import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ClusterId } from "~/lib/types";
import { getAuthMode } from "~/lib/auth/mode.server";

/**
 * CNI template used to materialize a per-namespace Multus NAD for a static pool
 * (from IPPool.spec.cni).
 */
export type IpPoolCniConfig = {
  /** CNI plugin type (typically `bridge`) */
  type: string;
  /** Linux bridge on hypervisors (e.g. br0, br-external) */
  bridge: string;
  /** Optional 802.1Q VLAN id */
  vlan?: number;
};

/**
 * Console view of a Multus IPv4 pool (mapped from cluster-scoped IPPool CRs or
 * dynamic VPC NAD annotations — not from clusters.yaml).
 */
export type IpPoolConfig = {
  /** Stable id written to VM annotation kmc.ianunruh.com/ipam-pool */
  id: string;
  /**
   * Multus NetworkAttachmentDefinition name this pool serves.
   * Accepts `bridge-external` or `namespace/bridge-external`.
   */
  multusNetwork: string;
  /** e.g. 74.82.62.0/24 */
  cidr: string;
  /**
   * Default gateway for guest netplan routes.
   * Optional for pure-L2 VPC pools (addresses only, no default route).
   */
  gateway?: string;
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
  /**
   * When set, controller/console can create this Multus NAD in a tenant
   * namespace if missing (ensure-on-demand for shared/public networks).
   */
  cni?: IpPoolCniConfig;
};

/**
 * Console view of a VLAN range for self-service VPCs (mapped from cluster-scoped
 * VLANPool CRs — not from clusters.yaml).
 */
export type VlanPoolConfig = {
  id: string;
  /** Inclusive start VLAN id (e.g. 3000) */
  start: number;
  /** Inclusive end VLAN id (e.g. 3100) */
  end: number;
  /** Linux bridge on hypervisors (e.g. br0) */
  bridge: string;
  /** Default DNS for VPC IPAM when the user does not override */
  dns?: string[];
  /** VLANs never allocated (hand-managed segments, etc.) */
  exclude?: number[];
};

/**
 * Cluster underlay CIDRs used by shared router guests (pod NIC routing).
 * Required to launch routers with a pod network + in-guest agent.
 */
export type ClusterNetworkConfig = {
  /** Pod network CIDR(s), e.g. 10.19.0.0/16 — routes via the guest pod NIC */
  podCIDR: string | string[];
  /** Service ClusterIP CIDR(s), e.g. 10.20.0.0/16 */
  serviceCIDR: string | string[];
  /** Optional CoreDNS / cluster DNS ClusterIP for the guest resolver */
  dnsIP?: string;
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
  /**
   * Base URL for Prometheus HTTP API (e.g. https://prometheus.example.com).
   * When the hostname is behind edge-sso, kmc sends the platform SA token as
   * Bearer (allowlist `kmc-system/kmc` on the SecurityPolicy).
   */
  prometheusUrl?: string;
  /**
   * Public S3 API base URL for ObjectBucketClaim access
   * (e.g. https://s3.kcloud.zone). In-cluster RGW DNS still comes from the OBC ConfigMap.
   */
  objectStorageEndpoint?: string;
  /** Optional underlay CIDRs for dual-home Multus guests (pod NIC routes). */
  network?: ClusterNetworkConfig;
  /** Dev Box access (internal MetalLB + optional Envoy OIDC). */
  devbox?: ClusterDevboxConfig;
};

export type ClusterDevboxConfig = {
  metallb?: {
    addressPool?: string;
    /** Default metallb.io/address-pool */
    annotationKey?: string;
  };
  envoy?: {
    gatewayName: string;
    gatewayNamespace?: string;
    sectionName?: string;
    /** `%name%` and `%namespace%` replaced. */
    hostTemplate: string;
    oidc: {
      issuer: string;
      /** Namespace Dex watches for OAuth2Client CRs (default `dex`). */
      clientNamespace?: string;
      cookieDomain?: string;
      scopes?: string[];
    };
  };
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
    objectStorageEndpoint?: string;
    network?: {
      podCIDR?: string | string[];
      serviceCIDR?: string | string[];
      dnsIP?: string;
    };
    devbox?: ClusterDevboxConfig;
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
      objectStorageEndpoint: normalizeHttpEndpoint(
        raw.objectStorageEndpoint,
        raw.id,
        "objectStorageEndpoint",
      ),
      network: parseClusterNetwork(raw.network, raw.id),
      devbox: parseDevboxConfig(raw.devbox, raw.id),
    });
  }
  const settingsCluster = doc.settingsCluster?.trim() || undefined;
  return { identities: map, settingsCluster };
}

function parseCidrList(
  raw: string | string[] | undefined,
  field: string,
  clusterId: string,
): string[] {
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const out = list.map((c) => String(c).trim()).filter(Boolean);
  if (out.length === 0) {
    throw new Error(
      `Cluster "${clusterId}": network.${field} is required when network is set`,
    );
  }
  for (const cidr of out) {
    // Basic shape check; full parse lives in ipam/cidr when used
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr)) {
      throw new Error(
        `Cluster "${clusterId}": network.${field} entry "${cidr}" is not a valid IPv4 CIDR`,
      );
    }
  }
  return out;
}

function parseClusterNetwork(
  raw:
    | {
        podCIDR?: string | string[];
        serviceCIDR?: string | string[];
        dnsIP?: string;
      }
    | undefined,
  clusterId: string,
): ClusterNetworkConfig | undefined {
  if (raw == null) return undefined;
  const podList = parseCidrList(raw.podCIDR, "podCIDR", clusterId);
  const svcList = parseCidrList(raw.serviceCIDR, "serviceCIDR", clusterId);
  const dnsIP = raw.dnsIP?.trim() || undefined;
  if (dnsIP && !/^\d{1,3}(\.\d{1,3}){3}$/.test(dnsIP)) {
    throw new Error(
      `Cluster "${clusterId}": network.dnsIP "${dnsIP}" is not a valid IPv4 address`,
    );
  }
  return {
    podCIDR: podList.length === 1 ? podList[0]! : podList,
    serviceCIDR: svcList.length === 1 ? svcList[0]! : svcList,
    dnsIP,
  };
}

function parseDevboxConfig(
  raw: ClusterDevboxConfig | undefined,
  clusterId: string,
): ClusterDevboxConfig | undefined {
  if (raw == null) return undefined;
  const addressPool = raw.metallb?.addressPool?.trim();
  const annotationKey = raw.metallb?.annotationKey?.trim();
  const envoyRaw = raw.envoy;
  let envoy: ClusterDevboxConfig["envoy"] | undefined;
  if (envoyRaw) {
    const gatewayName = envoyRaw.gatewayName?.trim();
    const hostTemplate = envoyRaw.hostTemplate?.trim();
    const issuer = envoyRaw.oidc?.issuer?.trim();
    if (!gatewayName || !hostTemplate || !issuer) {
      throw new Error(
        `Cluster "${clusterId}": devbox.envoy requires gatewayName, hostTemplate, and oidc.issuer`,
      );
    }
    envoy = {
      gatewayName,
      gatewayNamespace: envoyRaw.gatewayNamespace?.trim() || undefined,
      sectionName: envoyRaw.sectionName?.trim() || undefined,
      hostTemplate,
      oidc: {
        issuer,
        clientNamespace: envoyRaw.oidc?.clientNamespace?.trim() || undefined,
        cookieDomain: envoyRaw.oidc?.cookieDomain?.trim() || undefined,
        scopes: envoyRaw.oidc?.scopes?.map((s) => s.trim()).filter(Boolean),
      },
    };
  }
  if (!addressPool && !envoy) return undefined;
  return {
    metallb: addressPool
      ? { addressPool, annotationKey: annotationKey || undefined }
      : undefined,
    envoy,
  };
}

/** Dev Box access config for a cluster, if configured. */
export function getClusterDevboxConfig(id: ClusterId): ClusterDevboxConfig | null {
  return getClusterIdentity(id)?.devbox ?? null;
}

/** Underlay CIDRs for a cluster, if configured. */
export function getClusterNetwork(id: ClusterId): ClusterNetworkConfig | null {
  return getClusterIdentity(id)?.network ?? null;
}

/** Flatten pod + service CIDRs for guest route installation. */
export function clusterNetworkCidrList(network: ClusterNetworkConfig): {
  podCIDRs: string[];
  serviceCIDRs: string[];
} {
  const podCIDRs = Array.isArray(network.podCIDR) ? network.podCIDR : [network.podCIDR];
  const serviceCIDRs = Array.isArray(network.serviceCIDR)
    ? network.serviceCIDR
    : [network.serviceCIDR];
  return { podCIDRs, serviceCIDRs };
}

export type ClusterPrometheus = {
  url: string;
  /** Platform SA token for edge-sso JWT; omitted in kubeconfig-only mode. */
  token?: string;
};

/** Prometheus client config for a cluster, if configured. */
export function getClusterPrometheus(id: ClusterId): ClusterPrometheus | null {
  const identity = getClusterIdentity(id);
  if (!identity) return null;
  const url = identity.prometheusUrl?.trim();
  if (!url) return null;
  let token: string | undefined;
  try {
    token = resolveClusterToken(identity);
  } catch {
    // kubeconfig mode with no token/tokenFile/tokenEnv
  }
  return { url, token };
}

/** Prometheus base URL for a cluster, if configured. */
export function getClusterPrometheusUrl(id: ClusterId): string | null {
  return getClusterPrometheus(id)?.url ?? null;
}

export function hasClusterPrometheus(id: ClusterId): boolean {
  return getClusterPrometheusUrl(id) != null;
}

/**
 * Public S3 endpoint for Object Storage UI (from clusters.yaml).
 * Does not include a trailing slash.
 */
export function getClusterObjectStorageEndpoint(id: ClusterId): string | null {
  const url = getClusterIdentity(id)?.objectStorageEndpoint?.trim();
  return url || null;
}

/** Trim + require absolute http(s) URL; strip trailing slash. */
function normalizeHttpEndpoint(
  raw: string | undefined,
  clusterId: string,
  field: string,
): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(`Cluster "${clusterId}": ${field} "${v}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Cluster "${clusterId}": ${field} must be http(s) (got "${v}")`);
  }
  // Drop trailing slash for consistent --endpoint-url usage
  return v.replace(/\/+$/, "");
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
