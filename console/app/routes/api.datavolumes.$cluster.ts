import type { Route } from "./+types/api.datavolumes.$cluster";
import { listReusableDataVolumes } from "~/datavolumes/datavolumes.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  const cluster = params.cluster;
  if (!cluster) {
    throw new Response("cluster required", { status: 400 });
  }
  const url = new URL(request.url);
  const namespace = url.searchParams.get("namespace")?.trim() ?? "";
  if (!namespace) {
    throw new Response("namespace query parameter required", { status: 400 });
  }
  try {
    const dataVolumes = await listReusableDataVolumes(cluster, namespace);
    return { dataVolumes };
  } catch (err) {
    throw new Response(err instanceof Error ? err.message : String(err), {
      status: 500,
    });
  }
}
