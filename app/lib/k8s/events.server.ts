import type { ClusterId, ResourceEvent } from "~/lib/types";
import { getClusterClients } from "./clients.server";

export interface ListResourceEventsOptions {
  cluster: ClusterId;
  /** Involved object name */
  name: string;
  /**
   * Namespace of the resource (and of events for namespaced objects).
   * Omit for cluster-scoped resources — searches all namespaces by name.
   */
  namespace?: string;
  /**
   * If set, only keep events whose involvedObject.kind is in this list.
   * Useful when a name is shared (e.g. VirtualMachine + VirtualMachineInstance).
   */
  kinds?: string[];
  /** Max events after sort (newest first). Default 50. */
  limit?: number;
}

interface KubeEvent {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTime?: string;
  series?: { count?: number; lastObservedTime?: string };
  source?: { component?: string; host?: string };
  reportingComponent?: string;
  reportingInstance?: string;
  involvedObject?: {
    kind?: string;
    name?: string;
    namespace?: string;
    uid?: string;
  };
  metadata?: {
    creationTimestamp?: string;
  };
}

/**
 * List events related to a Kubernetes resource.
 * Failures return an empty list so detail pages still render.
 */
export async function listResourceEvents(
  opts: ListResourceEventsOptions,
): Promise<ResourceEvent[]> {
  const { cluster, name, namespace, kinds, limit = 50 } = opts;
  if (!name?.trim()) return [];

  try {
    const { core } = getClusterClients(cluster);
    const fieldSelector = `involvedObject.name=${name}`;

    let items: KubeEvent[];
    if (namespace) {
      const res = await core.listNamespacedEvent({
        namespace,
        fieldSelector,
      });
      items = (res.items ?? []) as KubeEvent[];
    } else {
      const res = await core.listEventForAllNamespaces({
        fieldSelector,
      });
      items = (res.items ?? []) as KubeEvent[];
    }

    const kindSet = kinds?.length ? new Set(kinds) : null;
    const mapped = items
      .filter((ev) => {
        if (!kindSet) return true;
        const kind = ev.involvedObject?.kind;
        return kind != null && kindSet.has(kind);
      })
      .map(mapEvent);

    mapped.sort((a, b) => {
      const ta = eventSortTime(a);
      const tb = eventSortTime(b);
      return tb - ta;
    });

    return mapped.slice(0, limit);
  } catch {
    return [];
  }
}

function mapEvent(ev: KubeEvent): ResourceEvent {
  const sourceParts = [
    ev.source?.component,
    ev.source?.host,
    ev.reportingComponent,
  ].filter(Boolean);
  const last =
    ev.lastTimestamp ||
    ev.series?.lastObservedTime ||
    ev.eventTime ||
    ev.metadata?.creationTimestamp;
  const first = ev.firstTimestamp || ev.eventTime || ev.metadata?.creationTimestamp;
  const count = ev.count ?? ev.series?.count ?? 1;

  return {
    type: ev.type || "Normal",
    reason: ev.reason || "Unknown",
    message: ev.message || "",
    source: sourceParts.length ? sourceParts.join("/") : undefined,
    count,
    firstTimestamp: first,
    lastTimestamp: last,
    involvedKind: ev.involvedObject?.kind,
    involvedName: ev.involvedObject?.name,
  };
}

function eventSortTime(ev: ResourceEvent): number {
  const iso = ev.lastTimestamp || ev.firstTimestamp;
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}
