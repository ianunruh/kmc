import type { Route } from "./+types/api.vms.$cluster.$namespace.$name.metrics";
import { getVmMetrics, parseMetricsRange } from "~/lib/prometheus/vm-metrics.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  const url = new URL(request.url);
  const range = parseMetricsRange(url.searchParams.get("range"));

  try {
    return await getVmMetrics({ cluster, namespace, name, range });
  } catch (err) {
    throw new Response(err instanceof Error ? err.message : String(err), {
      status: 500,
    });
  }
}
