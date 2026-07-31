import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export type SerialConsoleStatus = "connecting" | "open" | "closed" | "error";

type Props = {
  cluster: string;
  namespace: string;
  name: string;
  onStatus?: (status: SerialConsoleStatus, detail?: string) => void;
};

function serialWsUrl(cluster: string, namespace: string, name: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const path =
    `/api/vms/${encodeURIComponent(cluster)}/` +
    `${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/serial`;
  return `${proto}://${window.location.host}${path}`;
}

/**
 * Browser serial terminal: xterm.js ↔ kmc WS proxy ↔ KubeVirt console.
 *
 * Receive path MUST be synchronous (or strictly queued). KubeVirt sends many
 * tiny frames; async Blob.text()/FileReader reorders them → "etst" / "Passwrod".
 * KubeVirt exclusive-console also means Strict Mode double-mount must settle first.
 */
export function SerialConsole({ cluster, namespace, name, onStatus }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const onStatusRef = useRef(onStatus);

  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let ws: WebSocket | null = null;
    let opened = false;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let dataDisp: { dispose: () => void } | null = null;
    let ro: ResizeObserver | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    // stream:true so multi-byte UTF-8 split across frames still decodes correctly
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const setStatus = (status: SerialConsoleStatus, detail?: string) => {
      onStatusRef.current?.(status, detail);
    };

    const ensureSize = () => {
      if (!term || !fit) return;
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }
      // Zero-size terminals swallow writes — force a usable geometry.
      if (term.cols < 2 || term.rows < 2) {
        term.resize(80, 24);
      }
    };

    /** Sync decode + write — preserves frame order. */
    const writeGuestChunk = (data: unknown) => {
      if (!term) return;
      if (typeof data === "string") {
        term.write(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        term.write(decoder.decode(data, { stream: true }));
        return;
      }
      if (ArrayBuffer.isView(data)) {
        term.write(
          decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
            stream: true,
          }),
        );
      }
      // Ignore unknown types — never async-decode here (reorders tiny frames).
    };

    const sendToGuest = (data: string) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        term?.writeln("\r\n\x1b[31m(not connected — hit Reconnect)\x1b[0m");
        return;
      }
      // Binary frame, same bytes as typed — order preserved by the browser
      ws.send(encoder.encode(data));
    };

    term = new Terminal({
      cursorBlink: true,
      cursorStyle: "underline",
      fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: "#0b0d0f",
        foreground: "#e6edf3",
        cursor: "#7ee787",
        selectionBackground: "#264f78",
        black: "#0b0d0f",
        red: "#ff7b72",
        green: "#7ee787",
        yellow: "#d29922",
        blue: "#79c0ff",
        magenta: "#d2a8ff",
        cyan: "#a5d6ff",
        white: "#e6edf3",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#a5d6ff",
        brightWhite: "#ffffff",
      },
      convertEol: true,
      scrollback: 5000,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    ensureSize();

    setStatus("connecting");
    term.writeln("\x1b[90mConnecting to serial console…\x1b[0m");

    dataDisp = term.onData((data) => {
      sendToGuest(data);
    });

    ro = new ResizeObserver(() => ensureSize());
    ro.observe(host);

    // Defer connect so React Strict Mode's first mount/cleanup can finish.
    // KubeVirt allows only one console session; racing two WS opens drops both.
    connectTimer = setTimeout(() => {
      if (disposed) return;

      try {
        ws = new WebSocket(serialWsUrl(cluster, namespace, name));
        // arraybuffer → sync decode in onmessage (avoids out-of-order Blob.text())
        ws.binaryType = "arraybuffer";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus("error", msg);
        term?.writeln(`\x1b[31mFailed to open WebSocket: ${msg}\x1b[0m`);
        return;
      }

      ws.onopen = () => {
        if (disposed || !term) return;
        opened = true;
        setStatus("open");
        term.writeln("\x1b[90mConnected. If you see no prompt, press Enter once.\x1b[0m");
        term.writeln("");
        ensureSize();
        term.focus();
        // Wake getty / reprint login (many guests are quiet until CR)
        nudgeTimer = setTimeout(() => {
          if (!disposed && ws?.readyState === WebSocket.OPEN) {
            ws.send(encoder.encode("\r"));
          }
        }, 250);
      };

      ws.onmessage = (ev) => {
        if (disposed || !term) return;
        writeGuestChunk(ev.data);
      };

      ws.onerror = () => {
        if (disposed) return;
        if (!opened) {
          setStatus("error", "WebSocket error");
          term?.writeln(
            "\x1b[31mWebSocket error (check auth / VM running / RBAC).\x1b[0m",
          );
        }
      };

      ws.onclose = (ev) => {
        if (disposed) return;
        if (opened) {
          setStatus("closed", ev.reason || `code ${ev.code}`);
          term?.writeln("");
          term?.writeln(
            `\x1b[90mDisconnected${ev.reason ? `: ${ev.reason}` : ` (${ev.code})`}.\x1b[0m`,
          );
          if (ev.code === 1005 || ev.code === 1006) {
            term?.writeln(
              "\x1b[90mHint: only one serial console at a time (close virtctl / other tabs), then Reconnect.\x1b[0m",
            );
          }
        } else {
          setStatus("error", ev.reason || `closed ${ev.code}`);
          term?.writeln(
            `\x1b[31mConnection failed${ev.reason ? `: ${ev.reason}` : ` (code ${ev.code})`}.\x1b[0m`,
          );
          term?.writeln(
            "\x1b[90mIs the VM Running? Are you signed in? Console subresource RBAC?\x1b[0m",
          );
        }
      };
    }, 50);

    requestAnimationFrame(() => ensureSize());

    return () => {
      disposed = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      dataDisp?.dispose();
      ro?.disconnect();
      if (
        ws &&
        (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
      ) {
        // Prefer close over abrupt drop so KubeVirt releases exclusive console
        try {
          ws.close(1000, "client dispose");
        } catch {
          /* ignore */
        }
      }
      term?.dispose();
    };
  }, [cluster, namespace, name, reconnectKey]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        ref={hostRef}
        style={{
          flex: 1,
          minHeight: 320,
          // FitAddon measures content box; keep padding outside xterm host
          background: "#0b0d0f",
          borderRadius: 4,
          border: "1px solid #1e242c",
          overflow: "hidden",
        }}
        onClick={() => {
          const el = hostRef.current?.querySelector("textarea, .xterm-helper-textarea");
          (el as HTMLTextAreaElement | null)?.focus();
        }}
      />
      <button
        type="button"
        data-reconnect
        style={{ display: "none" }}
        onClick={() => setReconnectKey((k) => k + 1)}
        aria-hidden
      />
    </div>
  );
}

/** Imperative reconnect helper for the page chrome. */
export function reconnectSerialConsole(root: HTMLElement | null): void {
  const btn = root?.querySelector("[data-reconnect]") as HTMLButtonElement | null;
  btn?.click();
}
