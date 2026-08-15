import type { Route } from "./+types/api.gateways.$cluster";
import { listGateways } from "~/httproutes/httproutes.server";

export async function loader({ params }: Route.LoaderArgs) {
  const cluster = params.cluster;
  if (!cluster) {
    throw new Response("Missing cluster", { status: 400 });
  }
  try {
    const gateways = await listGateways(cluster);
    return { gateways };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Response(message, { status: 500 });
  }
}
