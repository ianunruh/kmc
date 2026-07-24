/**
 * Production HTTP server: React Router request handler + VM console WebSockets
 * (serial + SSH terminal).
 *
 * Dev uses Vite's server via the kmc-vm-console-ws plugin (see vite.config.ts).
 */
import { createServer } from "node:http";
import { createRequestListener } from "@react-router/node";
import compression from "compression";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachSerialConsoleWs } from "./app/vms/serial-console-ws.server";
import { attachSshConsoleWs } from "./app/vms/ssh-console-ws.server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;
const buildPath = path.resolve(__dirname, "build/server/index.js");
const clientDir = path.resolve(__dirname, "build/client");

process.env.NODE_ENV = process.env.NODE_ENV ?? "production";

const build = await import(buildPath);

const app = express();
app.disable("x-powered-by");
app.use(compression());
app.use(
  "/assets",
  express.static(path.join(clientDir, "assets"), {
    immutable: true,
    maxAge: "1y",
  }),
);
app.use(express.static(clientDir));
app.use(express.static(path.resolve(__dirname, "public"), { maxAge: "1h" }));

const rrListener = createRequestListener({
  build: build as never,
  mode: process.env.NODE_ENV,
});

app.use((req, res) => {
  void rrListener(req, res);
});

const server = createServer(app);
server.on("clientError", (err, socket) => {
  console.warn(`[kmc] http clientError: ${err.message}`);
  try {
    if (!socket.destroyed) socket.destroy();
  } catch {
    /* ignore */
  }
});
attachSerialConsoleWs(server);
attachSshConsoleWs(server);

server.listen(port, () => {
  console.warn(`[kmc] http://localhost:${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
