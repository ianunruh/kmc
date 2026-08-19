import type { Route } from "./+types/port-forwards.$cluster.$namespace.$name.yaml";
import { YamlPanel } from "~/ui";
import { getPortForwardYaml } from "~/vpcs/vpcs.server";
import { tracedLoader } from "~/lib/request-traces.server";

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const yaml = await getPortForwardYaml(cluster, namespace, name);
  return { yaml };
});

export default function PortForwardYamlTab({ loaderData }: Route.ComponentProps) {
  return <YamlPanel yaml={loaderData.yaml} />;
}
