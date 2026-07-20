import * as http from "node:http";
import * as https from "node:https";
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

/**
 * Authenticated request against the current kubeconfig cluster.
 *
 * Uses Node's http(s) stack + applyToHTTPSOptions so cluster CA certs and
 * client certs from kubeconfig work. Global fetch/undici ignores the
 * legacy `agent` option and fails TLS verification for private CAs.
 */
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

  const opts: https.RequestOptions = {
    method: (init.method ?? "GET").toUpperCase(),
    headers: {},
  };
  await kc.applyToHTTPSOptions(opts);

  const headers = new Headers();
  // applyToHTTPSOptions may set headers as a plain object
  const existing = opts.headers;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    for (const [key, value] of Object.entries(existing)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, String(value));
      }
    }
  }
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const headerObject: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    headerObject[key] = value;
  });
  opts.headers = headerObject;

  const body =
    init.body == null
      ? undefined
      : typeof init.body === "string"
        ? init.body
        : Buffer.isBuffer(init.body)
          ? init.body
          : String(init.body);

  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value == null) continue;
          if (Array.isArray(value)) {
            for (const v of value) responseHeaders.append(key, v);
          } else {
            responseHeaders.set(key, value);
          }
        }
        resolve(
          new Response(buf, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage,
            headers: responseHeaders,
          }),
        );
      });
    });

    req.on("error", (err) => {
      const cause =
        err instanceof Error && "cause" in err
          ? (err as Error & { cause?: unknown }).cause
          : undefined;
      const detail =
        cause instanceof Error
          ? cause.message
          : err instanceof Error
            ? err.message
            : String(err);
      reject(new Error(`Kubernetes request failed: ${detail}`, { cause: err }));
    });

    if (body != null) {
      req.write(body);
    }
    req.end();
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
