import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * In-guest router agent source (app/vpcs/kmc-router-agent.py).
 * Embedded into cloud-init user-data and the policy ConfigMap (`agent.py`)
 * so running routers can self-update without recreating the VM.
 *
 * Always re-read from disk so a long-lived `pnpm dev` process does not keep
 * overwriting cluster ConfigMaps with a stale in-memory snapshot.
 *
 * Path resolution must work both:
 * - Dev / tsx: this module is app/vpcs/router-agent-script.ts → co-located .py
 * - Prod SSR bundle: import.meta.url is build/server/index.js → .py lives under
 *   app/vpcs (copied into the image), not next to the bundle
 */
function resolveAgentScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Co-located with this module (dev: app/vpcs/)
    join(here, "kmc-router-agent.py"),
    // Production image / monorepo (cwd is typically /app)
    join(process.cwd(), "app/vpcs/kmc-router-agent.py"),
    // Bundle at build/server → ../../app/vpcs
    join(here, "../../app/vpcs/kmc-router-agent.py"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `kmc-router-agent.py not found. Tried:\n${candidates.map((p) => `  ${p}`).join("\n")}`,
  );
}

export function getRouterAgentScript(): string {
  const raw = readFileSync(resolveAgentScriptPath(), "utf8");
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}
