import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * Attach KubeVirt serial console WS proxy on Vite's HTTP server.
 * Loads the attach module via Vite SSR so `~/` aliases resolve.
 * Path-filtered inside attach so HMR upgrades are never claimed.
 */
function serialConsoleWsPlugin(): Plugin {
  return {
    name: "kmc-serial-console-ws",
    configureServer(server) {
      const attach = async () => {
        if (!server.httpServer) return;
        try {
          const mod = await server.ssrLoadModule("./app/vms/serial-console-ws.server.ts");
          const attachSerialConsoleWs = mod.attachSerialConsoleWs as (
            s: typeof server.httpServer,
          ) => void;
          attachSerialConsoleWs(server.httpServer);
        } catch (err) {
          console.error("[kmc] failed to attach serial console WS:", err);
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
  plugins: [reactRouter(), serialConsoleWsPlugin()],
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    // Keep k8s client and its native deps out of the browser bundle.
    external: ["@kubernetes/client-node", "ws"],
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
