/**
 * App-proxied psql terminal over Kubernetes pod exec.
 *
 * Browser ──WS──► kmc ──k8s exec (TTY)──► primary postgres pod ──► psql (app user)
 *
 * Browser protocol (same shape as the VM SSH terminal):
 *   - binary frames: PTY bytes both directions
 *   - text frames (client→server): JSON control
 *       { "type": "resize", "cols": number, "rows": number }
 *
 * Attached alongside the VM console WS proxies (dev Vite plugin + prod server.ts).
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { PassThrough } from "node:stream";
import { Exec } from "@kubernetes/client-node";
import WebSocket, { WebSocketServer } from "ws";
import { getClusterClients } from "~/lib/k8s/clients.server";
import { runWithActor, toActor } from "~/lib/auth/actor.server";
import { isImpersonateMode } from "~/lib/auth/mode.server";
import { getSession } from "~/lib/auth/session.server";
import type { ClusterId } from "~/lib/types";
import { resolvePsqlSessionTarget } from "~/databases/databases.server";

const PSQL_PATH_RE =
  /^\/api\/databases\/([^/]+)\/([^/]+)\/([^/]+)\/psql\/?$/;
const EXEC_CONNECT_MS = 30_000;
/** Tear down idle sessions (no client input). */
const IDLE_MS = 30 * 60 * 1000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
const POSTGRES_CONTAINER = "postgres";

const ATTACHED_FLAG = Symbol.for("kmc.psqlConsoleWs");

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
    console.warn(`[kmc:psql] ${label} socket error: ${err.message}`);
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
  if (/not found|404/i.test(msg)) return 404;
  return 502;
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

function toBuffer(data: WebSocket.RawData | string | Buffer): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(String(data), "utf8");
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

/** PassThrough with terminal size so k8s Exec can send resize frames. */
type ResizablePassThrough = PassThrough & {
  columns: number;
  rows: number;
};

function createResizableStdout(cols: number, rows: number): ResizablePassThrough {
  const stream = new PassThrough() as ResizablePassThrough;
  stream.columns = cols;
  stream.rows = rows;
  return stream;
}

type SessionParts = {
  client: WebSocket;
  execWs?: WebSocket;
  stdin: PassThrough;
  stdout: ResizablePassThrough;
  stderr: PassThrough;
  idleTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
};

function closeSession(parts: SessionParts, why: string): void {
  if (parts.closed) return;
  parts.closed = true;
  if (parts.idleTimer) clearTimeout(parts.idleTimer);
  console.warn(`[kmc:psql] closing session: ${why}`);

  try {
    parts.stdin.end();
  } catch {
    /* ignore */
  }
  try {
    parts.stdout.destroy();
  } catch {
    /* ignore */
  }
  try {
    parts.stderr.destroy();
  } catch {
    /* ignore */
  }

  const execWs = parts.execWs as
    | (WebSocket & { terminate?: () => void; close?: (code?: number) => void })
    | undefined;
  if (execWs) {
    try {
      if (typeof execWs.terminate === "function") {
        execWs.terminate();
      } else if (typeof execWs.close === "function") {
        execWs.close();
      }
    } catch {
      /* ignore */
    }
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
}

function touchIdle(parts: SessionParts): void {
  if (parts.closed) return;
  if (parts.idleTimer) clearTimeout(parts.idleTimer);
  parts.idleTimer = setTimeout(() => {
    closeSession(parts, "idle timeout");
  }, IDLE_MS);
}

function sendClientText(client: WebSocket, text: string): void {
  if (client.readyState !== WebSocket.OPEN) return;
  try {
    client.send(Buffer.from(text, "utf8"), { binary: true });
  } catch {
    /* ignore */
  }
}

async function startPsqlSession(
  client: WebSocket,
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  if (client.readyState !== WebSocket.OPEN) {
    return;
  }

  const target = await resolvePsqlSessionTarget(cluster, namespace, name);
  const { kc } = getClusterClients(cluster);
  const exec = new Exec(kc);

  const stdin = new PassThrough();
  const stdout = createResizableStdout(DEFAULT_COLS, DEFAULT_ROWS);
  const stderr = new PassThrough();

  const parts: SessionParts = {
    client,
    stdin,
    stdout,
    stderr,
    closed: false,
  };

  client.on("error", (err) => closeSession(parts, `client error: ${err.message}`));
  client.on("close", () => closeSession(parts, "client close"));

  touchIdle(parts);

  const forwardOut = (chunk: Buffer | string) => {
    if (parts.closed || client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(toBuffer(chunk), { binary: true });
    } catch (err) {
      closeSession(
        parts,
        `client send failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  stdout.on("data", forwardOut);
  stderr.on("data", forwardOut);

  stdout.on("error", (err) =>
    closeSession(parts, `stdout error: ${err.message}`),
  );
  stderr.on("error", (err) =>
    closeSession(parts, `stderr error: ${err.message}`),
  );
  stdin.on("error", (err) =>
    closeSession(parts, `stdin error: ${err.message}`),
  );

  const command = [
    "env",
    `PGPASSWORD=${target.password}`,
    "TERM=xterm-256color",
    "PAGER=cat",
    "psql",
    "-h",
    "127.0.0.1",
    "-p",
    "5432",
    "-U",
    target.username,
    "-d",
    target.database,
  ];

  let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    if (!parts.execWs && !parts.closed) {
      sendClientText(
        client,
        `\r\n*** Timed out starting psql after ${EXEC_CONNECT_MS / 1000}s ***\r\n`,
      );
      closeSession(parts, "exec connect timeout");
    }
  }, EXEC_CONNECT_MS);

  try {
    const execWs = await exec.exec(
      namespace,
      target.podName,
      POSTGRES_CONTAINER,
      command,
      stdout,
      stderr,
      stdin,
      true,
      (status) => {
        const code =
          status.status === "Success"
            ? 0
            : Number(
                (status.details as { causes?: Array<{ message?: string }> } | undefined)
                  ?.causes?.[0]?.message ?? 1,
              );
        closeSession(
          parts,
          status.status === "Success"
            ? "psql exited"
            : `psql exited (${status.reason ?? status.message ?? code})`,
        );
      },
    );

    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = undefined;
    }

    parts.execWs = execWs as unknown as WebSocket;

    (execWs as { on?: (ev: string, cb: (...args: unknown[]) => void) => void }).on?.(
      "close",
      () => closeSession(parts, "exec closed"),
    );
    (execWs as { on?: (ev: string, cb: (...args: unknown[]) => void) => void }).on?.(
      "error",
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        closeSession(parts, `exec error: ${message}`);
      },
    );

    client.on("message", (data, isBinary) => {
      if (parts.closed) return;
      touchIdle(parts);

      if (!isBinary) {
        const text =
          typeof data === "string" ? data : toBuffer(data).toString("utf8");
        const resize = parseResize(text);
        if (resize) {
          parts.stdout.columns = resize.cols;
          parts.stdout.rows = resize.rows;
          parts.stdout.emit("resize");
        }
        return;
      }

      if (parts.stdin.destroyed || parts.stdin.writableEnded) return;
      try {
        parts.stdin.write(toBuffer(data));
      } catch (writeErr) {
        closeSession(
          parts,
          `stdin write failed: ${writeErr instanceof Error ? writeErr.message : writeErr}`,
        );
      }
    });

    console.warn(
      `[kmc:psql] shell ready ${cluster}/${namespace}/${name} pod=${target.podName} user=${target.username} db=${target.database}`,
    );
  } catch (err) {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = undefined;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[kmc:psql] exec failed ${cluster}/${namespace}/${name}:`,
      message,
    );
    sendClientText(client, `\r\n*** psql failed: ${message} ***\r\n`);
    closeSession(parts, message);
  }
}

export function attachPsqlConsoleWs(httpServer: HttpServer): void {
  const flagged = httpServer as HttpServer & { [ATTACHED_FLAG]?: boolean };
  if (flagged[ATTACHED_FLAG]) return;
  flagged[ATTACHED_FLAG] = true;

  const wss = new WebSocketServer({ noServer: true });
  wss.on("error", (err) => {
    console.error("[kmc:psql] WebSocketServer error:", err);
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const rawUrl = req.url ?? "";
    const pathname = rawUrl.split("?")[0] ?? "";
    const match = PSQL_PATH_RE.exec(pathname);
    if (!match) return;

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

        // Resolve target before upgrade so the client only opens when we can connect.
        try {
          await runWithActor(auth.actor, () =>
            resolvePsqlSessionTarget(cluster, namespace, name),
          );
        } catch (err) {
          const message =
            err instanceof Error
              ? err.message
              : "Failed to prepare psql session";
          const status = rejectStatusForOpenError(err);
          console.error(
            `[kmc:psql] resolve failed ${cluster}/${namespace}/${name}:`,
            message,
          );
          rejectUpgrade(socket, status, message);
          return;
        }

        if (socket.destroyed) return;

        console.warn(
          `[kmc:psql] open ${cluster}/${namespace}/${name} as ${auth.actor?.user ?? "kubeconfig"}`,
        );

        try {
          wss.handleUpgrade(req, socket, head, (client) => {
            client.on("error", (err) => {
              console.warn(
                `[kmc:psql] client error ${cluster}/${namespace}/${name}: ${err.message}`,
              );
            });
            wss.emit("connection", client, req);
            void runWithActor(auth.actor, () =>
              startPsqlSession(client, cluster, namespace, name),
            ).catch((err) => {
              console.error("[kmc:psql] startPsqlSession:", err);
              try {
                if (
                  client.readyState === WebSocket.OPEN ||
                  client.readyState === WebSocket.CONNECTING
                ) {
                  client.close(1011, "psql session failed");
                }
              } catch {
                /* ignore */
              }
            });
          });
        } catch (err) {
          console.error("[kmc:psql] handleUpgrade failed:", err);
          if (!socket.destroyed) {
            rejectUpgrade(socket, 500, "WebSocket upgrade failed");
          }
        }
      } catch (err) {
        console.error("[kmc:psql] upgrade error:", err);
        if (!socket.destroyed) {
          rejectUpgrade(socket, 500, "Internal error");
        }
      }
    })().catch((err) => {
      console.error("[kmc:psql] unhandled upgrade rejection:", err);
      if (!socket.destroyed) {
        rejectUpgrade(socket, 500, "Internal error");
      }
    });
  });
}
