import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * Attach console WS proxies (VM serial/SSH + database psql) on Vite's HTTP server.
 * Loads attach modules via Vite SSR so `~/` aliases resolve.
 * Path-filtered inside each attach so HMR upgrades are never claimed.
 */
function consoleWsPlugin(): Plugin {
  return {
    name: "kmc-console-ws",
    configureServer(server) {
      // Malformed client requests / abrupt disconnects on the HTTP server must
      // not take down the whole Vite process (default is often uncaught).
      server.httpServer?.on("clientError", (err, socket) => {
        console.warn(`[kmc] http clientError: ${err.message}`);
        try {
          if (!socket.destroyed) socket.destroy();
        } catch {
          /* ignore */
        }
      });

      const attach = async () => {
        if (!server.httpServer) return;
        try {
          const serialMod = await server.ssrLoadModule(
            "./app/vms/serial-console-ws.server.ts",
          );
          const sshMod = await server.ssrLoadModule("./app/vms/ssh-console-ws.server.ts");
          const psqlMod = await server.ssrLoadModule(
            "./app/databases/psql-console-ws.server.ts",
          );
          const attachSerialConsoleWs = serialMod.attachSerialConsoleWs as (
            s: typeof server.httpServer,
          ) => void;
          const attachSshConsoleWs = sshMod.attachSshConsoleWs as (
            s: typeof server.httpServer,
          ) => void;
          const attachPsqlConsoleWs = psqlMod.attachPsqlConsoleWs as (
            s: typeof server.httpServer,
          ) => void;
          attachSerialConsoleWs(server.httpServer);
          attachSshConsoleWs(server.httpServer);
          attachPsqlConsoleWs(server.httpServer);
        } catch (err) {
          console.error("[kmc] failed to attach console WS:", err);
        }
      };
      void attach();
      server.httpServer?.once("listening", () => {
        void attach();
      });
    },
  };
}

export default defineConfig({
  plugins: [reactRouter(), consoleWsPlugin()],
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    // Keep k8s client and its native deps out of the browser bundle.
    external: ["@kubernetes/client-node", "ws", "ssh2"],
    noExternal: [
      "@mantine/core",
      "@mantine/hooks",
      "@mantine/form",
      "@mantine/notifications",
      "@fontsource/geist-mono",
    ],
  },
  server: {
    port: 5173,
  },
});
