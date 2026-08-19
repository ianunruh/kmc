import type { Route } from "./+types/images.$cluster.$name.events";
import { EventsPanel } from "~/ui";
import { getImageNamespace } from "~/images/images.server";
import { listResourceEvents } from "~/lib/k8s/events.server";
import { tracedLoader } from "~/lib/request-traces.server";

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, name } = params;
  if (!cluster || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  const namespace = getImageNamespace();
  const events = await listResourceEvents({
    cluster,
    namespace,
    name,
    kinds: ["DataVolume", "PersistentVolumeClaim"],
  });

  return { events };
});

export default function ImageEventsTab({ loaderData }: Route.ComponentProps) {
  return <EventsPanel events={loaderData.events} showKind />;
}
