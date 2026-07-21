/**
 * App-proxied serial console WebSocket.
 *
 * Browser ──WS──► kmc ──WS (plain.kubevirt.io)──► apiserver console subresource
 *
 * Attached to the HTTP server in dev (Vite plugin) and prod (server.ts).
 * Only claims /api/vms/:cluster/:namespace/:name/serial so Vite HMR is untouched.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import WebSocket, { WebSocketServer } from "ws";
import { getClusterClients } from "~/lib/k8s/clients.server";
import { runWithActor, toActor } from "~/lib/auth/actor.server";
import { isImpersonateMode } from "~/lib/auth/mode.server";
import { getSession } from "~/lib/auth/session.server";
import type { ClusterId } from "~/lib/types";

/** KubeVirt plain binary stream (not k8s channel.k8s.io multiplexing). */
const KUBEVIRT_PLAIN = "plain.kubevirt.io";

const SERIAL_PATH_RE = /^\/api\/vms\/([^/]+)\/([^/]+)\/([^/]+)\/serial\/?$/;

/** Max time to dial apiserver console WS before failing the browser upgrade. */
const UPSTREAM_CONNECT_MS = 20_000;

/** Survive Vite SSR module reloads (WeakSet would reset with the module). */
const ATTACHED_FLAG = Symbol.for("kmc.serialConsoleWs");

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = message;
  socket.write(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
  );
  socket.destroy();
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 502:
      return "Bad Gateway";
    case 504:
      return "Gateway Timeout";
    default:
      return "Error";
  }
}

/** Map upstream open failures to an HTTP status for the browser upgrade. */
function rejectStatusForOpenError(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(msg)) return 504;
  return 502;
}

/** Prefer Kubernetes Status.message when the apiserver returns JSON. */
function summarizeHandshakeBody(body: string, statusCode: number): string {
  const trimmed = body.trim();
  if (!trimmed) return `HTTP ${statusCode}`;
  try {
    const parsed = JSON.parse(trimmed) as { message?: string; reason?: string };
    if (parsed.message) return parsed.message;
    if (parsed.reason) return `${parsed.reason} (HTTP ${statusCode})`;
  } catch {
    // plain text body
  }
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function authorizeUpgrade(req: IncomingMessage): Promise<
  | {
      ok: true;
      actor: ReturnType<typeof toActor> | null;
    }
  | { ok: false; status: number; message: string }
> {
  const cookie = req.headers.cookie ?? "";
  const fakeRequest = new Request("http://kmc.local/", {
    headers: cookie ? { cookie } : {},
  });

  let session = null;
  try {
    session = await getSession(fakeRequest);
  } catch {
    session = null;
  }

  if (isImpersonateMode()) {
    if (!session?.user) {
      return { ok: false, status: 401, message: "Sign in required" };
    }
    return { ok: true, actor: toActor(session.user) };
  }

  return { ok: true, actor: null };
}

function buildUpstreamUrl(server: string, namespace: string, name: string): string {
  const base = server.replace(/\/$/, "");
  const wsBase = base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  const path =
    `/apis/subresources.kubevirt.io/v1/namespaces/` +
    `${encodeURIComponent(namespace)}/virtualmachineinstances/` +
    `${encodeURIComponent(name)}/console`;
  return `${wsBase}${path}`;
}

/**
 * Flatten OutgoingHttpHeaders into a shape `ws` accepts, preserving
 * multi-value Impersonate-Group as a repeated header via string[].
 */
function headersForWs(
  headers: HttpsRequestOptions["headers"],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      out[key] = value.map(String);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

async function openUpstream(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<WebSocket> {
  const { kc } = getClusterClients(cluster);
  const clusterInfo = kc.getCurrentCluster();
  if (!clusterInfo?.server) {
    throw new Error(`No server configured for cluster "${cluster}"`);
  }

  const opts: HttpsRequestOptions = { headers: {} };
  await kc.applyToHTTPSOptions(opts);

  const url = buildUpstreamUrl(clusterInfo.server, namespace, name);

  return new Promise((resolve, reject) => {
    let settled = false;
    /** When set, ignore the companion `error` event until we parse the HTTP body. */
    let readingHandshakeBody = false;

    const upstream = new WebSocket(url, [KUBEVIRT_PLAIN], {
      headers: headersForWs(opts.headers),
      agent: opts.agent,
      // ca/cert/key are typically on the agent from applyToHTTPSOptions
      rejectUnauthorized: opts.rejectUnauthorized,
      auth: opts.auth,
    });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      upstream.off("error", onError);
      upstream.off("open", onOpen);
      upstream.off("unexpected-response", onUnexpected);
      fn();
    };

    const fail = (err: Error) => {
      settle(() => {
        try {
          // Drop half-open sockets quickly (timeout / bad handshake).
          upstream.terminate();
        } catch {
          /* ignore */
        }
        reject(err);
      });
    };

    const timer = setTimeout(() => {
      fail(
        new Error(
          `Timed out connecting to console after ${UPSTREAM_CONNECT_MS / 1000}s ` +
            `(VM running? exclusive console held elsewhere? network to apiserver?)`,
        ),
      );
    }, UPSTREAM_CONNECT_MS);

    const onError = (err: Error) => {
      // `unexpected-response` is usually followed by a generic error — wait for the body.
      if (readingHandshakeBody) return;
      fail(
        new Error(
          err.message?.trim()
            ? err.message
            : "WebSocket error connecting to console subresource",
        ),
      );
    };

    const onOpen = () => {
      settle(() => resolve(upstream));
    };

    /**
     * Failed HTTP→WS upgrade (403/404/500, etc.). The body often has a k8s Status.
     * Without this handler failures look like generic "socket hang up".
     */
    const onUnexpected = (_req: unknown, res: IncomingMessage) => {
      readingHandshakeBody = true;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const detail = summarizeHandshakeBody(body, res.statusCode ?? 0);
        console.error(
          `[kmc:console] upstream handshake HTTP ${res.statusCode} for ` +
            `${cluster}/${namespace}/${name}: ${detail}`,
        );
        fail(
          new Error(
            `Console handshake failed (HTTP ${res.statusCode ?? "?"}): ${detail}`,
          ),
        );
      });
      res.on("error", (err: Error) => {
        fail(
          new Error(
            `Console handshake failed (HTTP ${res.statusCode ?? "?"}): ${err.message}`,
          ),
        );
      });
    };

    upstream.once("error", onError);
    upstream.once("open", onOpen);
    upstream.once("unexpected-response", onUnexpected);
  });
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(String(data), "utf8");
}

function pipeSockets(client: WebSocket, upstream: WebSocket): void {
  let closed = false;
  const closeBoth = (why: string) => {
    if (closed) return;
    closed = true;
    console.warn(`[kmc:console] closing pair: ${why}`);
    if (
      client.readyState === WebSocket.OPEN ||
      client.readyState === WebSocket.CONNECTING
    ) {
      try {
        client.close(1011, why.slice(0, 120));
      } catch {
        /* ignore */
      }
    }
    if (
      upstream.readyState === WebSocket.OPEN ||
      upstream.readyState === WebSocket.CONNECTING
    ) {
      try {
        upstream.close();
      } catch {
        /* ignore */
      }
    }
  };

  const forward = (
    from: "client" | "upstream",
    to: WebSocket,
    data: WebSocket.RawData,
  ) => {
    if (to.readyState !== WebSocket.OPEN) {
      // Never silently drop — half-open pairs should tear down.
      closeBoth(`${from} sent data but peer not OPEN (state=${to.readyState})`);
      return;
    }
    try {
      // KubeVirt + browser: always binary frames (plain stream).
      to.send(toBuffer(data), { binary: true });
    } catch (err) {
      closeBoth(`${from === "client" ? "upstream" : "client"} send failed: ${err}`);
    }
  };

  client.on("message", (data) => forward("client", upstream, data));
  upstream.on("message", (data) => forward("upstream", client, data));

  client.on("close", (code, reason) =>
    closeBoth(`client close ${code} ${reason.toString()}`),
  );
  upstream.on("close", (code, reason) =>
    closeBoth(`upstream close ${code} ${reason.toString()}`),
  );
  client.on("error", (err) => closeBoth(`client error: ${err.message}`));
  upstream.on("error", (err) => closeBoth(`upstream error: ${err.message}`));
}

export function attachSerialConsoleWs(httpServer: HttpServer): void {
  const flagged = httpServer as HttpServer & { [ATTACHED_FLAG]?: boolean };
  if (flagged[ATTACHED_FLAG]) return;
  flagged[ATTACHED_FLAG] = true;

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const rawUrl = req.url ?? "";
    const pathname = rawUrl.split("?")[0] ?? "";
    const match = SERIAL_PATH_RE.exec(pathname);
    // Critical: leave non-console upgrades (Vite HMR) alone
    if (!match) return;

    // Keep the TCP socket alive while we auth + dial apiserver.
    const netSocket = socket as Duplex & {
      setTimeout?: (ms: number) => void;
      setNoDelay?: (noDelay?: boolean) => void;
    };
    netSocket.setTimeout?.(0);
    netSocket.setNoDelay?.(true);

    const cluster = decodeParam(match[1]!);
    const namespace = decodeParam(match[2]!);
    const name = decodeParam(match[3]!);

    void (async () => {
      try {
        const auth = await authorizeUpgrade(req);
        if (!auth.ok) {
          rejectUpgrade(socket, auth.status, auth.message);
          return;
        }

        // Open upstream first so browser "open" means guest console is live
        // (KubeVirt exclusive session is already held when the client connects).
        let upstream: WebSocket;
        try {
          upstream = await runWithActor(auth.actor, () =>
            openUpstream(cluster, namespace, name),
          );
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Failed to connect to console";
          const status = rejectStatusForOpenError(err);
          console.error(
            `[kmc:console] upstream open failed ${cluster}/${namespace}/${name}:`,
            message,
          );
          rejectUpgrade(socket, status, message);
          return;
        }

        if (socket.destroyed) {
          upstream.close();
          return;
        }

        console.warn(
          `[kmc:console] open ${cluster}/${namespace}/${name} as ${auth.actor?.user ?? "kubeconfig"}`,
        );

        wss.handleUpgrade(req, socket, head, (client) => {
          wss.emit("connection", client, req);
          pipeSockets(client, upstream);
        });
      } catch (err) {
        console.error("[kmc:console] upgrade error:", err);
        if (!socket.destroyed) {
          rejectUpgrade(socket, 500, "Internal error");
        }
      }
    })();
  });
}
