import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * In-guest NAT agent source (app/vpcs/kmc-nat-agent.py).
 * Embedded into cloud-init user-data and the policy ConfigMap (`agent.py`)
 * so running gateways can self-update without recreating the VM.
 */
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "kmc-nat-agent.py");

export const KMC_NAT_AGENT_SCRIPT = readFileSync(scriptPath, "utf8");
