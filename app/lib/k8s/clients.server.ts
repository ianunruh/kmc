import * as http from "node:http";
import * as https from "node:https";
import * as k8s from "@kubernetes/client-node";
import type { ClusterId } from "~/lib/types";
import { getActor, type Actor } from "~/lib/auth/actor.server";
import { getAuthMode } from "~/lib/auth/mode.server";
import {
  getClusterIdentity,
  getSettingsClusterId,
  listClusterIds,
  requireClusterIdentity,
  resolveClusterToken,
} from "./cluster-config.server";

export { listClusterIds, getSettingsClusterId };

/** @deprecated Use listClusterIds — kept for gradual call-site updates */
export function getConfiguredContexts(): ClusterId[] {
  return listClusterIds();
}

export interface ClusterClients {
  id: ClusterId;
  kc: k8s.KubeConfig;
  custom: k8s.CustomObjectsApi;
  core: k8s.CoreV1Api;
  storage: k8s.StorageV1Api;
  networking: k8s.NetworkingV1Api;
}

function loadKubeconfigContext(context: ClusterId): k8s.KubeConfig {
  const base = new k8s.KubeConfig();
  base.loadFromDefault();
  const contexts = base.getContexts().map((c) => c.name);
  if (!contexts.includes(context)) {
    throw new Error(
      `Kubernetes context "${context}" not found in kubeconfig. Available: ${contexts.join(", ") || "(none)"}`,
    );
  }

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  kc.setCurrentContext(context);
  return kc;
}

function loadFromPlatformSa(cluster: ClusterId): k8s.KubeConfig {
  const identity = requireClusterIdentity(cluster);
  const token = resolveClusterToken(identity);

  const clusterConfig: k8s.Cluster = {
    name: identity.id,
    server: identity.apiServer,
    caData: identity.caData,
    caFile: identity.caFile,
    skipTLSVerify: false,
  };

  const user: k8s.User = {
    name: `kmc-${identity.id}`,
    token,
  };

  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [clusterConfig],
    users: [user],
    contexts: [
      {
        name: identity.id,
        cluster: identity.id,
        user: user.name,
      },
    ],
    currentContext: identity.id,
  });
  return kc;
}

/**
 * Fetch / node-fetch collapse repeated headers into a single comma-joined
 * value. The apiserver requires *repeated* Impersonate-Group headers, which
 * only Node's http(s).request does correctly with string[] values.
 *
 * Custom HTTP library used by typed API clients (CustomObjectsApi, etc.).
 */
function nodeHttpLibrary(): ReturnType<typeof k8s.wrapHttpLibrary> {
  return k8s.wrapHttpLibrary({
    async send(request) {
      const url = new URL(request.getUrl());
      const method = request.getHttpMethod().toString();
      const body = request.getBody();
      const agent = request.getAgent() as http.Agent | https.Agent | undefined;

      const outgoing: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(request.getHeaders())) {
        if (value == null) continue;
        // Preserve string[] so Node emits repeated headers (Impersonate-Group)
        outgoing[key] = value as string | string[] | number;
      }

      const transport = url.protocol === "https:" ? https : http;
      const opts: https.RequestOptions = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: outgoing,
        agent,
      };

      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = transport.request(opts, resolve);
        req.on("error", reject);
        if (body != null && body !== "") {
          if (typeof body === "string" || Buffer.isBuffer(body)) {
            req.write(body);
          } else {
            req.write(String(body));
          }
        }
        req.end();
      });

      const chunks: Buffer[] = [];
      for await (const chunk of res) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buf = Buffer.concat(chunks);

      const headers: { [key: string]: string } = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (value == null) continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }

      return new k8s.ResponseContext(res.statusCode ?? 0, headers, {
        text: async () => buf.toString("utf8"),
        binary: async () => buf,
      });
    },
  });
}

function makeApiClients(
  kc: k8s.KubeConfig,
): Pick<ClusterClients, "custom" | "core" | "storage" | "networking"> {
  const cluster = kc.getCurrentCluster();
  if (!cluster?.server) {
    throw new Error("No active cluster server in kubeconfig");
  }

  const config = k8s.createConfiguration({
    baseServer: new k8s.ServerConfiguration(cluster.server, {}),
    authMethods: { default: kc },
    httpApi: nodeHttpLibrary(),
  });

  return {
    custom: new k8s.CustomObjectsApi(config),
    core: new k8s.CoreV1Api(config),
    storage: new k8s.StorageV1Api(config),
    networking: new k8s.NetworkingV1Api(config),
  };
}

/**
 * Inject Impersonate-User / Impersonate-Group on every request.
 *
 * Typed clients use applySecurityAuthentication (not applyToHTTPSOptions).
 * We store Impersonate-Group as string[] on the request header map so our
 * Node HTTP library can emit repeated headers.
 */
function installImpersonation(kc: k8s.KubeConfig, actor: Actor): void {
  const user = kc.getCurrentUser();
  if (user) {
    (user as k8s.User & { impersonateUser?: string }).impersonateUser = actor.user;
  }

  const origSecurity = kc.applySecurityAuthentication.bind(kc);
  kc.applySecurityAuthentication = async (context) => {
    await origSecurity(context);
    context.setHeaderParam("Impersonate-User", actor.user);
    // Bypass setHeaderParam string coercion — keep array for multi headers
    const headers = context.getHeaders() as Record<string, string | string[]>;
    headers["Impersonate-Group"] = [...actor.groups];
  };

  const origHttps = kc.applyToHTTPSOptions.bind(kc);
  kc.applyToHTTPSOptions = async (opts: https.RequestOptions) => {
    await origHttps(opts);
    const headers = (opts.headers ?? {}) as http.OutgoingHttpHeaders;
    headers["Impersonate-User"] = actor.user;
    headers["Impersonate-Group"] = [...actor.groups];
    opts.headers = headers;
  };
}

export function getClusterClients(cluster: ClusterId): ClusterClients {
  const mode = getAuthMode();
  let kc: k8s.KubeConfig;

  if (mode === "impersonate") {
    const identity = getClusterIdentity(cluster);
    if (identity) {
      kc = loadFromPlatformSa(cluster);
    } else {
      kc = loadKubeconfigContext(cluster);
    }
    const actor = getActor();
    if (!actor) {
      throw new Error(
        `Auth mode is impersonate but no actor is set for cluster "${cluster}". Auth middleware must establish the session actor.`,
      );
    }
    if (actor.groups.filter((g) => g !== "system:authenticated").length === 0) {
      console.warn(
        `[kmc:auth] actor ${actor.user} has no org groups — API calls will likely 403. Check GitHub OAuth org approval and KMC_GITHUB_ORGS. See /me`,
      );
    }
    installImpersonation(kc, actor);
  } else {
    kc = loadKubeconfigContext(cluster);
  }

  const apis = makeApiClients(kc);
  return {
    id: cluster,
    kc,
    ...apis,
  };
}

/**
 * Clients for the settings cluster **without** user impersonation.
 *
 * Used for app-level stores (SSH keys) in `kmc-system`. In impersonate mode the
 * platform SA talks as itself; ownership is enforced in app code. In kubeconfig
 * mode this is the operator's local context for the settings cluster.
 */
export function getSettingsClusterClients(): ClusterClients {
  const cluster = getSettingsClusterId();
  const mode = getAuthMode();
  let kc: k8s.KubeConfig;

  if (mode === "impersonate") {
    const identity = getClusterIdentity(cluster);
    if (identity) {
      kc = loadFromPlatformSa(cluster);
    } else {
      kc = loadKubeconfigContext(cluster);
    }
    // Deliberately no installImpersonation — platform SA must write kmc-system.
  } else {
    kc = loadKubeconfigContext(cluster);
  }

  const apis = makeApiClients(kc);
  return {
    id: cluster,
    kc,
    ...apis,
  };
}

/**
 * Authenticated request against the current kubeconfig cluster.
 *
 * Uses Node's http(s) stack + applyToHTTPSOptions so cluster CA certs and
 * repeated Impersonate-Group headers work.
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

  const base = cluster.server.endsWith("/") ? cluster.server : `${cluster.server}/`;
  const url = new URL(path.replace(/^\//, ""), base);

  const opts: https.RequestOptions = {
    method: (init.method ?? "GET").toUpperCase(),
    headers: {},
  };
  await kc.applyToHTTPSOptions(opts);

  // Start from applyToHTTPSOptions headers (may include string[] for groups)
  const headerObject: http.OutgoingHttpHeaders = {
    ...(opts.headers as http.OutgoingHttpHeaders),
  };

  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => {
      // Don't clobber multi-value Impersonate-Group with a single set
      if (key.toLowerCase() === "impersonate-group") return;
      headerObject[key] = value;
    });
  }
  if (init.body && !headerObject["Content-Type"] && !headerObject["content-type"]) {
    headerObject["Content-Type"] = "application/json";
  }
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
