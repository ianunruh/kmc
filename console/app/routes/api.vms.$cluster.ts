import type { Route } from "./+types/api.vms.$cluster";
import { listVmOptionsForNamespace } from "~/httproutes/httproutes.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  const cluster = params.cluster;
  if (!cluster) {
    throw new Response("Missing cluster", { status: 400 });
  }
  const url = new URL(request.url);
  const namespace = url.searchParams.get("namespace")?.trim();
  if (!namespace) {
    throw new Response("namespace query parameter is required", { status: 400 });
  }
  try {
    const vms = await listVmOptionsForNamespace(cluster, namespace);
    return { vms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Response(message, { status: 500 });
  }
}
