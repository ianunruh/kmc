import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * In-guest router agent source (app/vpcs/kmc-router-agent.py).
 * Embedded into cloud-init user-data and the policy ConfigMap (`agent.py`)
 * so running routers can self-update without recreating the VM.
 *
 * Always re-read from disk so a long-lived `pnpm dev` process does not keep
 * overwriting cluster ConfigMaps with a stale in-memory snapshot.
 */
const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "kmc-router-agent.py",
);

export function getRouterAgentScript(): string {
  const raw = readFileSync(scriptPath, "utf8");
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

/** @deprecated Prefer getRouterAgentScript() — this was a one-shot import cache. */
export const KMC_ROUTER_AGENT_SCRIPT = getRouterAgentScript();
