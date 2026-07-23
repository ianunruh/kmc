import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * In-guest NAT agent source (app/vpcs/kmc-nat-agent.sh).
 * Embedded into cloud-init user-data for NAT gateways.
 */
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "kmc-nat-agent.sh");

export const KMC_NAT_AGENT_SCRIPT = readFileSync(scriptPath, "utf8");
