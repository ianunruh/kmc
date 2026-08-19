import type { Route } from "./+types/routers.$cluster.$namespace.$name.yaml";
import { YamlPanel } from "~/ui";
import { getRouterYaml } from "~/vpcs/routers.server";
import { tracedLoader } from "~/lib/request-traces.server";

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const yaml = await getRouterYaml(cluster, namespace, name);
  return { yaml };
});

export default function RouterYamlTab({ loaderData }: Route.ComponentProps) {
  return <YamlPanel yaml={loaderData.yaml} />;
}
