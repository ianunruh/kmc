import type { Route } from "./+types/api.router-attachable.$cluster";
import { listRouterAttachableVpcs } from "~/vpcs/routers.server";

/**
 * Free / blocked VPCs for router attach (create form + detail).
 * GET /api/router-attachable/:cluster?namespace=
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const cluster = params.cluster;
  if (!cluster) {
    throw new Response("cluster required", { status: 400 });
  }
  const url = new URL(request.url);
  const namespace = url.searchParams.get("namespace")?.trim() ?? "";
  if (!namespace) {
    return { attachable: [] as Awaited<ReturnType<typeof listRouterAttachableVpcs>> };
  }
  try {
    const attachable = await listRouterAttachableVpcs(cluster, namespace);
    return { attachable };
  } catch (err) {
    throw new Response(err instanceof Error ? err.message : String(err), {
      status: 500,
    });
  }
}
