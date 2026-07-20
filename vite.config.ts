import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    // Keep k8s client and its native deps out of the browser bundle.
    external: ["@kubernetes/client-node"],
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
