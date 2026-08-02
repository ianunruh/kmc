import type { Route } from "./+types/routers.$cluster.$namespace.$name.events";
import { EventsPanel } from "~/ui";
import { listResourceEvents } from "~/lib/k8s/events.server";

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  // Router CR events from the controller, plus the appliance VM (same name).
  const events = await listResourceEvents({
    cluster,
    namespace,
    name,
    kinds: ["Router", "VirtualMachine", "VirtualMachineInstance"],
  });

  return { events };
}

export default function RouterEventsTab({ loaderData }: Route.ComponentProps) {
  return <EventsPanel events={loaderData.events} showKind />;
}
