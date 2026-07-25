/**
 * In-cluster CronJob runner logic for VM snapshot schedules.
 * No request-scoped auth — uses the Job pod ServiceAccount via loadFromCluster.
 */
import * as k8s from "@kubernetes/client-node";
import {
  KMC_ANN_SCHEDULE_LAST_ERROR,
  KMC_ANN_SCHEDULE_LAST_PRUNED,
  KMC_ANN_SCHEDULE_LAST_RUN_AT,
  KMC_ANN_SCHEDULE_LAST_SNAPSHOT,
  KMC_ANN_SCHEDULE_LAST_SUCCESS_AT,
  KMC_SNAPSHOT_SCHEDULE_DATA_KEY,
} from "~/lib/k8s/constants";
import { formatError } from "~/lib/errors";
import {
  createVmSnapshotWithClient,
  deleteVmSnapshotWithClient,
  listVmSnapshotsWithClient,
} from "~/snapshots/snapshots.server";
import {
  parseSnapshotScheduleDoc,
  type SnapshotScheduleDoc,
} from "~/snapshots/schedules.server";

const IN_PROGRESS_PHASES = new Set(["InProgress", "Creating", "Pending"]);

function makeInClusterClients(): {
  core: k8s.CoreV1Api;
  custom: k8s.CustomObjectsApi;
} {
  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();
  const cluster = kc.getCurrentCluster();
  if (!cluster?.server) {
    throw new Error("In-cluster kubeconfig has no server");
  }
  const config = k8s.createConfiguration({
    baseServer: new k8s.ServerConfiguration(cluster.server, {}),
    authMethods: { default: kc },
  });
  return {
    core: new k8s.CoreV1Api(config),
    custom: new k8s.CustomObjectsApi(config),
  };
}

async function patchScheduleStatus(
  core: k8s.CoreV1Api,
  namespace: string,
  configMapName: string,
  patch: {
    lastRunAt?: string;
    lastSuccessAt?: string;
    lastSnapshot?: string | null;
    lastError?: string | null;
    lastPruned?: string | null;
  },
): Promise<void> {
  const cm = await core.readNamespacedConfigMap({
    name: configMapName,
    namespace,
  });
  const annotations: Record<string, string> = {
    ...(cm.metadata?.annotations ?? {}),
  };
  if (patch.lastRunAt) {
    annotations[KMC_ANN_SCHEDULE_LAST_RUN_AT] = patch.lastRunAt;
  }
  if (patch.lastSuccessAt) {
    annotations[KMC_ANN_SCHEDULE_LAST_SUCCESS_AT] = patch.lastSuccessAt;
  }
  if (patch.lastSnapshot === null) {
    delete annotations[KMC_ANN_SCHEDULE_LAST_SNAPSHOT];
  } else if (patch.lastSnapshot) {
    annotations[KMC_ANN_SCHEDULE_LAST_SNAPSHOT] = patch.lastSnapshot;
  }
  if (patch.lastError === null) {
    delete annotations[KMC_ANN_SCHEDULE_LAST_ERROR];
  } else if (patch.lastError !== undefined) {
    // Truncate — annotation values should stay modest.
    annotations[KMC_ANN_SCHEDULE_LAST_ERROR] = patch.lastError.slice(0, 1024);
  }
  if (patch.lastPruned === null) {
    delete annotations[KMC_ANN_SCHEDULE_LAST_PRUNED];
  } else if (patch.lastPruned !== undefined) {
    annotations[KMC_ANN_SCHEDULE_LAST_PRUNED] = patch.lastPruned.slice(0, 512);
  }

  await core.replaceNamespacedConfigMap({
    name: configMapName,
    namespace,
    body: {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: configMapName,
        namespace,
        labels: cm.metadata?.labels,
        annotations,
        resourceVersion: cm.metadata?.resourceVersion,
      },
      data: cm.data,
    },
  });
}

function isInProgressPhase(phase: string): boolean {
  const p = phase.trim();
  if (!p) return false;
  // Ready/Succeeded/Failed are terminal-ish for our skip logic.
  if (
    p === "Succeeded" ||
    p === "Failed" ||
    p === "Ready" ||
    p.toLowerCase() === "succeeded"
  ) {
    return false;
  }
  if (IN_PROGRESS_PHASES.has(p)) return true;
  // KubeVirt often uses empty or progressive condition names; treat non-ready
  // with no readyToUse as in-flight only when phase looks active.
  return /progress|creat|pend|start/i.test(p);
}

/**
 * Run one schedule tick: create snapshot (if allowed), prune, update status.
 */
export async function runScheduledSnapshotOnce(input: {
  namespace: string;
  configMapName: string;
  /** Cluster id for summaries only (labels in UI); defaults to "cluster". */
  clusterId?: string;
}): Promise<{
  skipped: boolean;
  reason?: string;
  snapshotName?: string;
  pruned: string[];
}> {
  const namespace = input.namespace.trim();
  const configMapName = input.configMapName.trim();
  if (!namespace) throw new Error("namespace is required");
  if (!configMapName) throw new Error("configMapName is required");

  const clusterId = input.clusterId?.trim() || "cluster";
  const { core, custom } = makeInClusterClients();
  const now = new Date().toISOString();

  let doc: SnapshotScheduleDoc;
  try {
    const cm = await core.readNamespacedConfigMap({
      name: configMapName,
      namespace,
    });
    const parsed = parseSnapshotScheduleDoc(
      cm.data?.[KMC_SNAPSHOT_SCHEDULE_DATA_KEY],
    );
    if (!parsed) {
      throw new Error("schedule.json missing or invalid");
    }
    doc = parsed;
  } catch (err) {
    throw new Error(
      `Failed to load schedule ${namespace}/${configMapName}: ${formatError(err)}`,
      { cause: err },
    );
  }

  if (!doc.enabled) {
    await patchScheduleStatus(core, namespace, configMapName, {
      lastRunAt: now,
      lastError: null,
    });
    return { skipped: true, reason: "schedule disabled", pruned: [] };
  }

  // Skip if a snapshot for this VM is still in progress (any kind).
  let existing;
  try {
    existing = await listVmSnapshotsWithClient(
      custom,
      clusterId,
      namespace,
      doc.vmName,
    );
  } catch (err) {
    const message = formatError(err);
    await patchScheduleStatus(core, namespace, configMapName, {
      lastRunAt: now,
      lastError: message,
    });
    throw new Error(message, { cause: err });
  }

  const inflight = existing.find(
    (s) => !s.readyToUse && isInProgressPhase(s.phase),
  );
  if (inflight) {
    await patchScheduleStatus(core, namespace, configMapName, {
      lastRunAt: now,
      lastError: `skipped: snapshot ${inflight.name} still in progress (phase=${inflight.phase})`,
    });
    return {
      skipped: true,
      reason: `in-progress snapshot ${inflight.name}`,
      pruned: [],
    };
  }

  let snapshotName: string;
  try {
    const created = await createVmSnapshotWithClient(custom, {
      cluster: clusterId,
      namespace,
      vmName: doc.vmName,
      scheduleName: configMapName,
      failureDeadline: doc.failureDeadline,
    });
    snapshotName = created.name;
  } catch (err) {
    const message = formatError(err);
    await patchScheduleStatus(core, namespace, configMapName, {
      lastRunAt: now,
      lastError: message,
    });
    throw new Error(message, { cause: err });
  }

  // Re-list and prune scheduled snaps for this schedule only.
  const pruned: string[] = [];
  try {
    const after = await listVmSnapshotsWithClient(
      custom,
      clusterId,
      namespace,
      doc.vmName,
    );
    const scheduled = after
      .filter((s) => s.scheduleName === configMapName)
      .sort((a, b) => {
        const ta = a.age || "";
        const tb = b.age || "";
        if (ta !== tb) return tb.localeCompare(ta);
        return a.name.localeCompare(b.name);
      });

    const retain = Math.max(1, doc.retain);
    const excess = scheduled.slice(retain);
    for (const snap of excess) {
      // Never prune a non-ready snap that might still be progressing.
      if (!snap.readyToUse && isInProgressPhase(snap.phase)) continue;
      try {
        await deleteVmSnapshotWithClient(custom, namespace, snap.name);
        pruned.push(snap.name);
      } catch (err) {
        console.error(
          `[kmc:snapshot-run] prune ${snap.name} failed:`,
          formatError(err),
        );
      }
    }
  } catch (err) {
    // Snapshot was created; record partial success + prune error.
    await patchScheduleStatus(core, namespace, configMapName, {
      lastRunAt: now,
      lastSuccessAt: now,
      lastSnapshot: snapshotName,
      lastError: `prune failed: ${formatError(err)}`,
      lastPruned: pruned.length ? pruned.join(",") : null,
    });
    return { skipped: false, snapshotName, pruned };
  }

  await patchScheduleStatus(core, namespace, configMapName, {
    lastRunAt: now,
    lastSuccessAt: now,
    lastSnapshot: snapshotName,
    lastError: null,
    lastPruned: pruned.length ? pruned.join(",") : null,
  });

  return { skipped: false, snapshotName, pruned };
}
