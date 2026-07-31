import type { Route } from "./+types/api.networks.$cluster";
import { listNetworks } from "~/lib/k8s/catalog.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  const cluster = params.cluster;
  if (!cluster) {
    throw new Response("cluster required", { status: 400 });
  }
  const url = new URL(request.url);
  const namespace = url.searchParams.get("namespace") ?? "";
  try {
    const networks = await listNetworks(cluster, namespace);
    return { networks };
  } catch (err) {
    throw new Response(err instanceof Error ? err.message : String(err), { status: 500 });
  }
}
