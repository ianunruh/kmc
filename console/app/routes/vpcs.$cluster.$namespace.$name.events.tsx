import type { Route } from "./+types/vpcs.$cluster.$namespace.$name.events";
import { EventsPanel } from "~/ui";
import { listResourceEvents } from "~/lib/k8s/events.server";
import { tracedLoader } from "~/lib/request-traces.server";

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  const events = await listResourceEvents({
    cluster,
    namespace,
    name,
    kinds: ["VPC"],
  });

  return { events };
});

export default function VpcEventsTab({ loaderData }: Route.ComponentProps) {
  return <EventsPanel events={loaderData.events} />;
}
