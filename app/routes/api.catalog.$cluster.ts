import type { Route } from "./+types/api.catalog.$cluster";
import { getClusterCatalog } from "~/lib/k8s/catalog.server";

export async function loader({ params }: Route.LoaderArgs) {
  const cluster = params.cluster;
  if (!cluster) {
    throw new Response("cluster required", { status: 400 });
  }
  try {
    return await getClusterCatalog(cluster);
  } catch (err) {
    throw new Response(err instanceof Error ? err.message : String(err), { status: 500 });
  }
}
