/**
 * App-proxied SSH terminal over KubeVirt port-forward.
 *
 * Browser ──WS──► kmc ──WS (plain.kubevirt.io)──► apiserver
 *   portforward/22 ──► guest :22 ──► server-side ssh2 (platform key) ──► shell PTY
 *
 * Browser protocol:
 *   - binary frames: PTY bytes both directions
 *   - text frames (client→server): JSON control, currently
 *       { "type": "resize", "cols": number, "rows": number }
 *
 * Attached alongside the serial console WS (dev Vite plugin + prod server.ts).
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { Duplex as DuplexStream } from "node:stream";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { Client as SshClient, type ClientChannel } from "ssh2";
import WebSocket, { WebSocketServer } from "ws";
import { getClusterClients } from "~/lib/k8s/clients.server";
import { runWithActor, toActor } from "~/lib/auth/actor.server";
import { isImpersonateMode } from "~/lib/auth/mode.server";
import { getSession } from "~/lib/auth/session.server";
import type { ClusterId } from "~/lib/types";
import {
  getConsoleSshUser,
  getPlatformConsoleKeyPair,
} from "~/vms/console-ssh-key.server";

const KUBEVIRT_PLAIN = "plain.kubevirt.io";
const SSH_PATH_RE = /^\/api\/vms\/([^/]+)\/([^/]+)\/([^/]+)\/ssh\/?$/;
const UPSTREAM_CONNECT_MS = 20_000;
const SSH_READY_MS = 30_000;
/** Tear down idle sessions (no client input). */
const IDLE_MS = 30 * 60 * 1000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
const GUEST_SSH_PORT = 22;

const ATTACHED_FLAG = Symbol.for("kmc.sshConsoleWs");

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = message;
  try {
    socket.write(
      `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "\r\n" +
        body,
    );
  } catch {
    /* client already gone */
  }
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
}

/** Raw upgrade sockets emit `error` on client disconnect — must not crash the process. */
function guardUpgradeSocket(socket: Duplex, label: string): void {
  socket.on("error", (err: Error) => {
    console.warn(`[kmc:ssh] ${label} socket error: ${err.message}`);
  });
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

function rejectStatusForOpenError(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(msg)) return 504;
  if (/sign in|unauthorized/i.test(msg)) return 401;
  if (/forbidden|denied|403/i.test(msg)) return 403;
  return 502;
}

function summarizeHandshakeBody(body: string, statusCode: number): string {
  const trimmed = body.trim();
  if (!trimmed) return `HTTP ${statusCode}`;
  try {
    const parsed = JSON.parse(trimmed) as { message?: string; reason?: string };
    if (parsed.message) return parsed.message;
    if (parsed.reason) return `${parsed.reason} (HTTP ${statusCode})`;
  } catch {
    // plain text
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

function buildPortForwardUrl(
  server: string,
  namespace: string,
  name: string,
  port: number,
): string {
  const base = server.replace(/\/$/, "");
  const wsBase = base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  const path =
    `/apis/subresources.kubevirt.io/v1/namespaces/` +
    `${encodeURIComponent(namespace)}/virtualmachineinstances/` +
    `${encodeURIComponent(name)}/portforward/${port}`;
  return `${wsBase}${path}`;
}

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

function toBuffer(data: WebSocket.RawData | string | Buffer): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(String(data), "utf8");
}

type PortForwardTunnel = {
  ws: WebSocket;
  /** Duplex that begins buffering guest bytes the instant the WS opens. */
  sock: DuplexStream;
};

/**
 * Wrap a KubeVirt plain stream WebSocket as a Node Duplex for ssh2 `sock`.
 *
 * Critical: attach this **before** the SSH server banner can arrive. sshd
 * sends `SSH-2.0-…` immediately on TCP connect; if that frame is dropped
 * while we await keys / browser upgrade, ssh2 hangs until readyTimeout.
 */
function wsToDuplex(ws: WebSocket): DuplexStream {
  const stream = new DuplexStream({
    write(chunk, _encoding, callback) {
      if (ws.readyState !== WebSocket.OPEN) {
        callback(new Error("port-forward WebSocket is not open"));
        return;
      }
      try {
        ws.send(toBuffer(chunk), { binary: true }, (err) => {
          callback(err ?? null);
        });
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
    read() {
      // push-driven from ws messages
    },
  });

  // ssh2 may call net.Socket methods; provide no-ops so they don't throw.
  const sock = stream as DuplexStream & {
    setNoDelay?: (noDelay?: boolean) => DuplexStream;
    setKeepAlive?: (enable?: boolean, initialDelay?: number) => DuplexStream;
    setTimeout?: (timeout: number, callback?: () => void) => DuplexStream;
    ref?: () => DuplexStream;
    unref?: () => DuplexStream;
    destroySoon?: () => void;
  };
  sock.setNoDelay = () => sock;
  sock.setKeepAlive = () => sock;
  sock.setTimeout = () => sock;
  sock.ref = () => sock;
  sock.unref = () => sock;
  sock.destroySoon = () => {
    sock.destroy();
  };

  // destroy(err) emits `error`; without a listener Node can exit the process.
  stream.on("error", (err) => {
    console.warn(`[kmc:ssh] port-forward duplex error: ${err.message}`);
  });

  ws.on("message", (data) => {
    if (!stream.destroyed) {
      stream.push(toBuffer(data));
    }
  });

  const endStream = () => {
    if (!stream.destroyed) {
      stream.push(null);
    }
  };

  ws.on("close", endStream);
  ws.on("error", (err) => {
    if (!stream.destroyed) {
      stream.destroy(err);
    }
  });

  stream.on("close", () => {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  });

  return stream;
}

async function openPortForward(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<PortForwardTunnel> {
  const { kc } = getClusterClients(cluster);
  const clusterInfo = kc.getCurrentCluster();
  if (!clusterInfo?.server) {
    throw new Error(`No server configured for cluster "${cluster}"`);
  }

  const opts: HttpsRequestOptions = { headers: {} };
  await kc.applyToHTTPSOptions(opts);

  const url = buildPortForwardUrl(
    clusterInfo.server,
    namespace,
    name,
    GUEST_SSH_PORT,
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let readingHandshakeBody = false;

    const upstream = new WebSocket(url, [KUBEVIRT_PLAIN], {
      headers: headersForWs(opts.headers),
      agent: opts.agent,
      rejectUnauthorized: opts.rejectUnauthorized,
      auth: opts.auth,
    });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep a permanent `error` listener — removing it before terminate()/after
      // resolve leaves a window where `ws` throws and exits the Node process.
      upstream.off("open", onOpen);
      upstream.off("unexpected-response", onUnexpected);
      fn();
    };

    const fail = (err: Error) => {
      settle(() => {
        try {
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
          `Timed out connecting to port-forward after ${UPSTREAM_CONNECT_MS / 1000}s ` +
            `(VM running? sshd up? portforward RBAC?)`,
        ),
      );
    }, UPSTREAM_CONNECT_MS);

    const onError = (err: Error) => {
      if (settled) {
        // Expected after terminate, or mid-session until startSshSession takes over.
        return;
      }
      if (readingHandshakeBody) return;
      fail(
        new Error(
          err.message?.trim()
            ? err.message
            : "WebSocket error connecting to portforward subresource",
        ),
      );
    };

    const onOpen = () => {
      // Bind duplex immediately so the guest SSH banner is not lost before
      // the browser upgrade / ssh2.connect runs.
      const sock = wsToDuplex(upstream);
      settle(() => resolve({ ws: upstream, sock }));
    };

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
          `[kmc:ssh] upstream handshake HTTP ${res.statusCode} for ` +
            `${cluster}/${namespace}/${name}: ${detail}`,
        );
        fail(
          new Error(
            `Port-forward handshake failed (HTTP ${res.statusCode ?? "?"}): ${detail}`,
          ),
        );
      });
      res.on("error", (err: Error) => {
        fail(
          new Error(
            `Port-forward handshake failed (HTTP ${res.statusCode ?? "?"}): ${err.message}`,
          ),
        );
      });
    };

    // Permanent listener (not once) so terminate / post-open errors never crash Node.
    upstream.on("error", onError);
    upstream.once("open", onOpen);
    upstream.once("unexpected-response", onUnexpected);
  });
}

type SessionParts = {
  client: WebSocket;
  upstream: WebSocket;
  ssh: SshClient;
  shell?: ClientChannel;
  sock: DuplexStream;
  idleTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
};

function closeSession(parts: SessionParts, why: string): void {
  if (parts.closed) return;
  parts.closed = true;
  if (parts.idleTimer) clearTimeout(parts.idleTimer);
  console.warn(`[kmc:ssh] closing session: ${why}`);

  try {
    parts.shell?.close();
  } catch {
    /* ignore */
  }
  try {
    parts.ssh.end();
  } catch {
    /* ignore */
  }
  try {
    if (!parts.sock.destroyed) parts.sock.destroy();
  } catch {
    /* ignore */
  }
  if (
    parts.client.readyState === WebSocket.OPEN ||
    parts.client.readyState === WebSocket.CONNECTING
  ) {
    try {
      parts.client.close(1011, why.slice(0, 120));
    } catch {
      /* ignore */
    }
  }
  if (
    parts.upstream.readyState === WebSocket.OPEN ||
    parts.upstream.readyState === WebSocket.CONNECTING
  ) {
    try {
      parts.upstream.close();
    } catch {
      /* ignore */
    }
  }
}

function touchIdle(parts: SessionParts): void {
  if (parts.closed) return;
  if (parts.idleTimer) clearTimeout(parts.idleTimer);
  parts.idleTimer = setTimeout(() => {
    closeSession(parts, "idle timeout");
  }, IDLE_MS);
}

function parseResize(raw: string): { cols: number; rows: number } | null {
  try {
    const msg = JSON.parse(raw) as {
      type?: string;
      cols?: unknown;
      rows?: unknown;
    };
    if (msg.type !== "resize") return null;
    const cols = Number(msg.cols);
    const rows = Number(msg.rows);
    if (
      !Number.isFinite(cols) ||
      !Number.isFinite(rows) ||
      cols < 2 ||
      rows < 2 ||
      cols > 500 ||
      rows > 200
    ) {
      return null;
    }
    return { cols: Math.floor(cols), rows: Math.floor(rows) };
  } catch {
    return null;
  }
}

async function startSshSession(
  client: WebSocket,
  tunnel: PortForwardTunnel,
  keyPair: Awaited<ReturnType<typeof getPlatformConsoleKeyPair>>,
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  const { ws: upstream, sock } = tunnel;
  const username = getConsoleSshUser();

  if (
    client.readyState !== WebSocket.OPEN ||
    upstream.readyState !== WebSocket.OPEN
  ) {
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
    try {
      upstream.terminate();
    } catch {
      /* ignore */
    }
    try {
      if (
        client.readyState === WebSocket.OPEN ||
        client.readyState === WebSocket.CONNECTING
      ) {
        client.close(1011, "peer closed before SSH");
      }
    } catch {
      /* ignore */
    }
    return;
  }

  const parts: SessionParts = {
    client,
    upstream,
    ssh: new SshClient(),
    sock,
    closed: false,
  };

  client.on("error", (err) => closeSession(parts, `client error: ${err.message}`));
  client.on("close", () => closeSession(parts, "client close"));
  upstream.on("error", (err) =>
    closeSession(parts, `port-forward error: ${err.message}`),
  );
  upstream.on("close", () => closeSession(parts, "port-forward close"));

  touchIdle(parts);

  const fail = (err: Error) => {
    console.error(
      `[kmc:ssh] session error ${cluster}/${namespace}/${name}:`,
      err.message,
    );
    if (
      client.readyState === WebSocket.OPEN &&
      !parts.shell // not yet streaming — send error text
    ) {
      try {
        client.send(
          Buffer.from(`\r\n*** SSH failed: ${err.message} ***\r\n`, "utf8"),
          { binary: true },
        );
      } catch {
        /* ignore */
      }
    }
    closeSession(parts, err.message);
  };

  // ssh2 Client also throws process-killing unhandled errors without a listener.
  parts.ssh.on("error", (err: Error) => {
    fail(err);
  });

  parts.ssh
    .on("ready", () => {
      parts.ssh.shell(
        {
          term: "xterm-256color",
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
        },
        (err, stream) => {
          if (err) {
            fail(err);
            return;
          }
          parts.shell = stream;

          stream.on("data", (data: Buffer | string) => {
            if (parts.closed || client.readyState !== WebSocket.OPEN) return;
            try {
              client.send(toBuffer(data), { binary: true });
            } catch (sendErr) {
              closeSession(
                parts,
                `client send failed: ${sendErr instanceof Error ? sendErr.message : sendErr}`,
              );
            }
          });

          stream.stderr?.on("data", (data: Buffer | string) => {
            if (parts.closed || client.readyState !== WebSocket.OPEN) return;
            try {
              client.send(toBuffer(data), { binary: true });
            } catch {
              /* ignore */
            }
          });

          stream.on("close", () => {
            closeSession(parts, "shell closed");
          });
          stream.on("error", (streamErr: Error) => {
            closeSession(parts, `shell error: ${streamErr.message}`);
          });

          client.on("message", (data, isBinary) => {
            if (parts.closed) return;
            touchIdle(parts);

            // Text control frames (resize). Node `ws` may deliver text as Buffer.
            if (!isBinary) {
              const text =
                typeof data === "string" ? data : toBuffer(data).toString("utf8");
              const resize = parseResize(text);
              if (resize && parts.shell) {
                try {
                  parts.shell.setWindow(resize.rows, resize.cols, 0, 0);
                } catch {
                  /* ignore */
                }
              }
              return;
            }

            // Binary PTY input
            if (!parts.shell || parts.shell.destroyed) return;
            try {
              parts.shell.write(toBuffer(data));
            } catch (writeErr) {
              closeSession(
                parts,
                `shell write failed: ${writeErr instanceof Error ? writeErr.message : writeErr}`,
              );
            }
          });

          console.warn(
            `[kmc:ssh] shell ready ${cluster}/${namespace}/${name} as ${username}`,
          );
        },
      );
    })
    .on("end", () => {
      closeSession(parts, "ssh end");
    })
    .on("close", () => {
      closeSession(parts, "ssh close");
    });

  const readyTimer = setTimeout(() => {
    if (!parts.shell && !parts.closed) {
      fail(
        new Error(
          `SSH handshake timed out after ${SSH_READY_MS / 1000}s ` +
            `(is sshd running? was this VM created after platform console key injection?)`,
        ),
      );
    }
  }, SSH_READY_MS);
  parts.ssh.on("ready", () => clearTimeout(readyTimer));
  parts.ssh.on("error", () => clearTimeout(readyTimer));
  parts.ssh.on("close", () => clearTimeout(readyTimer));

  // Duplex / sock errors from port-forward teardown
  sock.on("error", (err) => {
    closeSession(parts, `port-forward stream error: ${err.message}`);
  });

  try {
    parts.ssh.connect({
      sock,
      username,
      privateKey: keyPair.privateKeyPem,
      readyTimeout: SSH_READY_MS,
      // Guest host keys change per VM recreate — skip TOFU for console path.
      // Access is already gated by k8s RBAC + kmc session.
      hostVerifier: () => true,
    });
  } catch (err) {
    fail(err instanceof Error ? err : new Error(String(err)));
  }
}

export function attachSshConsoleWs(httpServer: HttpServer): void {
  const flagged = httpServer as HttpServer & { [ATTACHED_FLAG]?: boolean };
  if (flagged[ATTACHED_FLAG]) return;
  flagged[ATTACHED_FLAG] = true;

  const wss = new WebSocketServer({ noServer: true });
  wss.on("error", (err) => {
    console.error("[kmc:ssh] WebSocketServer error:", err);
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const rawUrl = req.url ?? "";
    const pathname = rawUrl.split("?")[0] ?? "";
    const match = SSH_PATH_RE.exec(pathname);
    if (!match) return;

    // Client abort / ECONNRESET during async auth+dial must not exit the process.
    guardUpgradeSocket(socket, "upgrade");

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

        if (socket.destroyed) return;

        // Load platform key *before* port-forward: the guest sends its SSH
        // banner immediately on connect; any delay after open risks losing it.
        let keyPair: Awaited<ReturnType<typeof getPlatformConsoleKeyPair>>;
        try {
          keyPair = await getPlatformConsoleKeyPair();
        } catch (err) {
          const message =
            err instanceof Error
              ? err.message
              : "Platform console SSH key unavailable";
          console.error("[kmc:ssh] platform key load failed:", message);
          rejectUpgrade(
            socket,
            502,
            `Platform console SSH key unavailable: ${message}. ` +
              `Ensure Secret ${"kmc-system/kmc-console-ssh"} is readable and RBAC allows secrets in kmc-system.`,
          );
          return;
        }

        if (socket.destroyed) return;

        let tunnel: PortForwardTunnel;
        try {
          tunnel = await runWithActor(auth.actor, () =>
            openPortForward(cluster, namespace, name),
          );
        } catch (err) {
          const message =
            err instanceof Error
              ? err.message
              : "Failed to open port-forward to guest SSH";
          const status = rejectStatusForOpenError(err);
          console.error(
            `[kmc:ssh] port-forward open failed ${cluster}/${namespace}/${name}:`,
            message,
          );
          rejectUpgrade(socket, status, message);
          return;
        }

        if (socket.destroyed) {
          try {
            tunnel.sock.destroy();
          } catch {
            /* ignore */
          }
          try {
            tunnel.ws.terminate();
          } catch {
            /* ignore */
          }
          return;
        }

        console.warn(
          `[kmc:ssh] open ${cluster}/${namespace}/${name} as ${auth.actor?.user ?? "kubeconfig"}`,
        );

        try {
          wss.handleUpgrade(req, socket, head, (client) => {
            client.on("error", (err) => {
              console.warn(
                `[kmc:ssh] client error ${cluster}/${namespace}/${name}: ${err.message}`,
              );
            });
            wss.emit("connection", client, req);
            void startSshSession(
              client,
              tunnel,
              keyPair,
              cluster,
              namespace,
              name,
            ).catch((err) => {
              console.error("[kmc:ssh] startSshSession:", err);
              try {
                tunnel.sock.destroy();
              } catch {
                /* ignore */
              }
              try {
                tunnel.ws.terminate();
              } catch {
                /* ignore */
              }
              try {
                if (
                  client.readyState === WebSocket.OPEN ||
                  client.readyState === WebSocket.CONNECTING
                ) {
                  client.close(1011, "SSH session failed");
                }
              } catch {
                /* ignore */
              }
            });
          });
        } catch (err) {
          console.error("[kmc:ssh] handleUpgrade failed:", err);
          try {
            tunnel.sock.destroy();
          } catch {
            /* ignore */
          }
          try {
            tunnel.ws.terminate();
          } catch {
            /* ignore */
          }
          if (!socket.destroyed) {
            rejectUpgrade(socket, 500, "WebSocket upgrade failed");
          }
        }
      } catch (err) {
        console.error("[kmc:ssh] upgrade error:", err);
        if (!socket.destroyed) {
          rejectUpgrade(socket, 500, "Internal error");
        }
      }
    })().catch((err) => {
      // Belt-and-suspenders: never let an async upgrade rejection kill Vite/Node.
      console.error("[kmc:ssh] unhandled upgrade rejection:", err);
      if (!socket.destroyed) {
        rejectUpgrade(socket, 500, "Internal error");
      }
    });
  });
}
