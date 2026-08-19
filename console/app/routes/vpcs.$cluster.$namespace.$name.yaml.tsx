import type { Route } from "./+types/vpcs.$cluster.$namespace.$name.yaml";
import { YamlPanel } from "~/ui";
import { getVpcYaml } from "~/vpcs/vpcs.server";
import { tracedLoader } from "~/lib/request-traces.server";

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const yaml = await getVpcYaml(cluster, namespace, name);
  return { yaml };
});

export default function VpcYamlTab({ loaderData }: Route.ComponentProps) {
  return <YamlPanel yaml={loaderData.yaml} />;
}
