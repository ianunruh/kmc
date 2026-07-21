import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ClusterId } from "~/lib/types";
import { getAuthMode } from "~/lib/auth/mode.server";

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
};

type ClustersFile = {
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
  }>;
};

const DEFAULT_CONTEXTS = ["prod-sjc1", "homelab"];

let cached: {
  path: string;
  mtimeMs: number;
  identities: Map<string, ClusterIdentity>;
} | null = null;

function configPath(): string {
  return resolve(process.env.KMC_CLUSTERS_CONFIG ?? "config/clusters.yaml");
}

function loadFromYaml(path: string): Map<string, ClusterIdentity> {
  if (!existsSync(path)) {
    return new Map();
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
    });
  }
  return map;
}

/** Prometheus base URL for a cluster, if configured. */
export function getClusterPrometheusUrl(id: ClusterId): string | null {
  const url = getClusterIdentity(id)?.prometheusUrl?.trim();
  return url || null;
}

export function hasClusterPrometheus(id: ClusterId): boolean {
  return getClusterPrometheusUrl(id) != null;
}

function getIdentities(): Map<string, ClusterIdentity> {
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
    return cached.identities;
  }
  const identities = loadFromYaml(path);
  cached = { path, mtimeMs, identities };
  return identities;
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
