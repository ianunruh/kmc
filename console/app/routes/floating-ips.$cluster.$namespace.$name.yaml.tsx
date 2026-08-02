import type { Route } from "./+types/floating-ips.$cluster.$namespace.$name.yaml";
import { YamlPanel } from "~/ui";
import { getFloatingIpYaml } from "~/vpcs/vpcs.server";

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const yaml = await getFloatingIpYaml(cluster, namespace, name);
  return { yaml };
}

export default function FloatingIpYamlTab({ loaderData }: Route.ComponentProps) {
  return <YamlPanel yaml={loaderData.yaml} />;
}
