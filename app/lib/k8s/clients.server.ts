import * as k8s from "@kubernetes/client-node";
import type { ClusterId } from "~/lib/types";

const DEFAULT_CONTEXTS = ["prod-sjc1", "homelab"];

export function getConfiguredContexts(): ClusterId[] {
  const env = process.env.KMC_CONTEXTS?.trim();
  if (env) {
    return env
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }
  return DEFAULT_CONTEXTS;
}

export interface ClusterClients {
  id: ClusterId;
  kc: k8s.KubeConfig;
  custom: k8s.CustomObjectsApi;
  core: k8s.CoreV1Api;
  storage: k8s.StorageV1Api;
}

function loadBaseConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc;
}

export function getClusterClients(context: ClusterId): ClusterClients {
  const base = loadBaseConfig();
  const contexts = base.getContexts().map((c) => c.name);
  if (!contexts.includes(context)) {
    throw new Error(
      `Kubernetes context "${context}" not found in kubeconfig. Available: ${contexts.join(", ") || "(none)"}`,
    );
  }

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  kc.setCurrentContext(context);

  return {
    id: context,
    kc,
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
    core: kc.makeApiClient(k8s.CoreV1Api),
    storage: kc.makeApiClient(k8s.StorageV1Api),
  };
}

export async function k8sFetch(
  kc: k8s.KubeConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const cluster = kc.getCurrentCluster();
  if (!cluster?.server) {
    throw new Error("No cluster server configured in kubeconfig");
  }

  const base = cluster.server.endsWith("/")
    ? cluster.server
    : `${cluster.server}/`;
  const url = new URL(path.replace(/^\//, ""), base);

  const authOpts = await kc.applyToFetchOptions({});
  const headers = new Headers(authOpts.headers as HeadersInit | undefined);
  const initHeaders = new Headers(init.headers);
  initHeaders.forEach((value, key) => headers.set(key, value));

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // applyToFetchOptions returns node-fetch-ish types; cast for undici fetch.
  return fetch(url, {
    method: init.method ?? (authOpts.method as string | undefined) ?? "GET",
    headers,
    body: init.body,
    // @ts-expect-error node undici agent from kubeconfig
    agent: (authOpts as { agent?: unknown }).agent,
  });
}

export function httpErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      message?: string;
      reason?: string;
    };
    if (parsed.message) return parsed.message;
    if (parsed.reason) return parsed.reason;
  } catch {
    // ignore
  }
  return body || `HTTP ${status}`;
}
