import type { Route } from "./+types/floating-ips.$cluster.$namespace.$name.events";
import { EventsPanel } from "~/ui";
import { listResourceEvents } from "~/lib/k8s/events.server";
import { getFloatingIp } from "~/vpcs/vpcs.server";
import { tracedLoader } from "~/lib/request-traces.server";

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  // Resolve CR name when the path used a public address form.
  const fip = await getFloatingIp(cluster, namespace, name);
  const events = await listResourceEvents({
    cluster,
    namespace,
    name: fip.name,
    kinds: ["FloatingIP"],
  });

  return { events };
});

export default function FloatingIpEventsTab({ loaderData }: Route.ComponentProps) {
  return <EventsPanel events={loaderData.events} />;
}
