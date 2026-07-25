/**
 * CronJob entrypoint: create a scheduled VirtualMachineSnapshot and prune old ones.
 *
 * Env:
 *   KMC_SNAPSHOT_NAMESPACE  — namespace of the schedule ConfigMap (required)
 *   KMC_SNAPSHOT_SCHEDULE   — schedule ConfigMap name (required)
 *   KMC_SNAPSHOT_CLUSTER_ID — optional label for logs/summaries
 *
 * Runs in-cluster with the schedule ServiceAccount (loadFromCluster).
 */
/* eslint-disable no-console -- Job pod logs to stdout/stderr intentionally */
import { runScheduledSnapshotOnce } from "../app/snapshots/scheduled-run.server";
async function main(): Promise<void> {
  const namespace = process.env.KMC_SNAPSHOT_NAMESPACE?.trim();
  const configMapName = process.env.KMC_SNAPSHOT_SCHEDULE?.trim();
  const clusterId = process.env.KMC_SNAPSHOT_CLUSTER_ID?.trim();

  if (!namespace || !configMapName) {
    console.error(
      "usage: KMC_SNAPSHOT_NAMESPACE and KMC_SNAPSHOT_SCHEDULE must be set",
    );
    process.exit(2);
  }

  console.log(
    `[kmc:snapshot-run] start namespace=${namespace} schedule=${configMapName}`,
  );

  try {
    const result = await runScheduledSnapshotOnce({
      namespace,
      configMapName,
      clusterId,
    });
    if (result.skipped) {
      console.log(
        `[kmc:snapshot-run] skipped: ${result.reason ?? "unknown"}`,
      );
    } else {
      console.log(
        `[kmc:snapshot-run] created snapshot=${result.snapshotName}` +
          (result.pruned.length
            ? ` pruned=${result.pruned.join(",")}`
            : " pruned=none"),
      );
    }
  } catch (err) {
    console.error("[kmc:snapshot-run] failed:", err);
    process.exit(1);
  }
}

void main();
