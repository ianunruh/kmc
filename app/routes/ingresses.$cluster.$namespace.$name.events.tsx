import type { Route } from "./+types/ingresses.$cluster.$namespace.$name.events";
import { EventsPanel } from "~/ui";
import { listResourceEvents } from "~/lib/k8s/events.server";

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  const events = await listResourceEvents({
    cluster,
    namespace,
    name,
    kinds: ["Ingress", "Service"],
  });

  return { events };
}

export default function IngressEventsTab({ loaderData }: Route.ComponentProps) {
  return <EventsPanel events={loaderData.events} />;
}
