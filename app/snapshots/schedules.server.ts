import { formatError } from "~/lib/errors";
import type {
  ClusterId,
  UpsertVmSnapshotScheduleRequest,
  VmSnapshotScheduleSummary,
} from "~/lib/types";
import {
  KMC_ANN_SCHEDULE_LAST_ERROR,
  KMC_ANN_SCHEDULE_LAST_PRUNED,
  KMC_ANN_SCHEDULE_LAST_RUN_AT,
  KMC_ANN_SCHEDULE_LAST_SNAPSHOT,
  KMC_ANN_SCHEDULE_LAST_SUCCESS_AT,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_SCHEDULE,
  KMC_LABEL_VM,
  KMC_MANAGED_BY,
  KMC_RESOURCE_VM_SNAPSHOT_SCHEDULE,
  KMC_SNAPSHOT_SCHEDULE_DATA_KEY,
  KMC_SNAPSHOT_SCHEDULE_LABEL_SELECTOR,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import { getClusterClients } from "~/lib/k8s/clients.server";
import {
  SNAPSHOT_SCHEDULE_RETAIN_MAX,
  SNAPSHOT_SCHEDULE_RETAIN_MIN,
} from "~/snapshots/schedule-constants";

export {
  cronPresetLabel,
  SNAPSHOT_SCHEDULE_PRESETS,
  SNAPSHOT_SCHEDULE_RETAIN_DEFAULT,
  SNAPSHOT_SCHEDULE_RETAIN_MAX,
  SNAPSHOT_SCHEDULE_RETAIN_MIN,
} from "~/snapshots/schedule-constants";

/** Standard 5-field cron (minute hour day-of-month month day-of-week). */
const CRON_5_FIELD =
  /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;

/** Policy document stored in the schedule ConfigMap. */
export type SnapshotScheduleDoc = {
  apiVersion: "kmc.ianunruh.com/v1";
  kind: "VmSnapshotSchedule";
  vmName: string;
  enabled: boolean;
  cron: string;
  retain: number;
  failureDeadline?: string;
  /** Companion CronJob name (written on upsert for the runner / UI). */
  cronJobName: string;
};

function dnsLabel(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 63).replace(/-+$/g, "") || "sched";
}

/**
 * Stable object names for a per-VM schedule.
 * CronJob names must stay ≤52 chars (Job name = CronJob + timestamp suffix).
 */
export function snapshotScheduleObjectNames(vmName: string): {
  configMap: string;
  cronJob: string;
  serviceAccount: string;
  role: string;
} {
  const stem = dnsLabel(vmName).slice(0, 40).replace(/-+$/g, "") || "vm";
  const cronJob = dnsLabel(`kmc-snap-${stem}`).slice(0, 52).replace(/-+$/g, "");
  const sa = dnsLabel(`kmc-snap-${stem}`).slice(0, 63);
  return {
    configMap: dnsLabel(`kmc-snap-sched-${stem}`),
    cronJob,
    serviceAccount: sa,
    role: sa,
  };
}

function apiStatusCode(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const o = err as { code?: unknown; statusCode?: unknown; response?: { statusCode?: unknown } };
    const n = Number(o.code ?? o.statusCode ?? o.response?.statusCode);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function isNotFound(err: unknown): boolean {
  if (apiStatusCode(err) === 404) return true;
  const message = formatError(err).toLowerCase();
  return message.includes("not found");
}

function isAlreadyExists(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  if (message.includes("already exists") || message.includes("alreadyexists")) {
    return true;
  }
  return apiStatusCode(err) === 409;
}

export function validateCronExpression(cron: string): string | null {
  const c = cron.trim();
  if (!c) return "cron expression is required";
  if (!CRON_5_FIELD.test(c)) {
    return "cron must be a standard 5-field expression (minute hour dom month dow)";
  }
  if (c.length > 128) return "cron expression is too long";
  return null;
}

export function validateRetain(retain: number): string | null {
  if (!Number.isInteger(retain)) return "retain must be an integer";
  if (retain < SNAPSHOT_SCHEDULE_RETAIN_MIN || retain > SNAPSHOT_SCHEDULE_RETAIN_MAX) {
    return `retain must be between ${SNAPSHOT_SCHEDULE_RETAIN_MIN} and ${SNAPSHOT_SCHEDULE_RETAIN_MAX}`;
  }
  return null;
}

export function parseSnapshotScheduleDoc(
  raw: string | undefined,
): SnapshotScheduleDoc | null {
  if (!raw?.trim()) return null;
  try {
    const doc = JSON.parse(raw) as Partial<SnapshotScheduleDoc>;
    if (!doc.vmName?.trim() || !doc.cron?.trim()) return null;
    const retain = Number(doc.retain);
    if (!Number.isFinite(retain)) return null;
    return {
      apiVersion: "kmc.ianunruh.com/v1",
      kind: "VmSnapshotSchedule",
      vmName: doc.vmName.trim(),
      enabled: doc.enabled !== false,
      cron: doc.cron.trim(),
      retain: Math.trunc(retain),
      failureDeadline: doc.failureDeadline?.trim() || undefined,
      cronJobName: doc.cronJobName?.trim() || "",
    };
  } catch {
    return null;
  }
}

/** Default public image from CI (main → latest). Override with KMC_SNAPSHOT_JOB_IMAGE. */
const DEFAULT_SNAPSHOT_JOB_IMAGE = "ghcr.io/ianunruh/kmc:latest";

function scheduleImage(): string {
  return process.env.KMC_SNAPSHOT_JOB_IMAGE?.trim() || DEFAULT_SNAPSHOT_JOB_IMAGE;
}

function scheduleLabels(vmName: string, configMapName: string): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_VM_SNAPSHOT_SCHEDULE,
    [KMC_LABEL_VM]: vmName,
    [KMC_LABEL_SCHEDULE]: configMapName,
  };
}

function mapSummary(
  cluster: ClusterId,
  namespace: string,
  cm: {
    metadata?: {
      name?: string;
      annotations?: Record<string, string>;
    };
    data?: Record<string, string>;
  },
): VmSnapshotScheduleSummary | null {
  const name = cm.metadata?.name?.trim();
  if (!name) return null;
  const doc = parseSnapshotScheduleDoc(cm.data?.[KMC_SNAPSHOT_SCHEDULE_DATA_KEY]);
  if (!doc) return null;
  const names = snapshotScheduleObjectNames(doc.vmName);
  const ann = cm.metadata?.annotations ?? {};
  return {
    cluster,
    namespace,
    name,
    vmName: doc.vmName,
    enabled: doc.enabled,
    cron: doc.cron,
    retain: doc.retain,
    failureDeadline: doc.failureDeadline,
    cronJobName: doc.cronJobName || names.cronJob,
    lastRunAt: ann[KMC_ANN_SCHEDULE_LAST_RUN_AT]?.trim() || undefined,
    lastSuccessAt: ann[KMC_ANN_SCHEDULE_LAST_SUCCESS_AT]?.trim() || undefined,
    lastSnapshot: ann[KMC_ANN_SCHEDULE_LAST_SNAPSHOT]?.trim() || undefined,
    lastError: ann[KMC_ANN_SCHEDULE_LAST_ERROR]?.trim() || undefined,
    lastPruned: ann[KMC_ANN_SCHEDULE_LAST_PRUNED]?.trim() || undefined,
  };
}

/**
 * Load the schedule for a VM (at most one in v1). Returns null when missing.
 */
export async function getVmSnapshotSchedule(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<VmSnapshotScheduleSummary | null> {
  if (!cluster?.trim()) throw new Error("cluster is required");
  if (!namespace?.trim()) throw new Error("namespace is required");
  if (!vmName?.trim()) throw new Error("vmName is required");

  const names = snapshotScheduleObjectNames(vmName);
  const { core } = getClusterClients(cluster);
  try {
    const cm = await core.readNamespacedConfigMap({
      name: names.configMap,
      namespace,
    });
    return mapSummary(cluster, namespace, cm);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new Error(formatError(err), { cause: err });
  }
}

export async function listVmSnapshotSchedules(
  cluster: ClusterId,
  namespace: string,
  vmName?: string,
): Promise<VmSnapshotScheduleSummary[]> {
  if (!cluster?.trim()) throw new Error("cluster is required");
  if (!namespace?.trim()) throw new Error("namespace is required");

  const { core } = getClusterClients(cluster);
  try {
    const res = await core.listNamespacedConfigMap({
      namespace,
      labelSelector: KMC_SNAPSHOT_SCHEDULE_LABEL_SELECTOR,
    });
    let items = (res.items ?? [])
      .map((cm) => mapSummary(cluster, namespace, cm))
      .filter((s): s is VmSnapshotScheduleSummary => s != null);
    const want = vmName?.trim();
    if (want) {
      items = items.filter((s) => s.vmName === want);
    }
    items.sort((a, b) => a.vmName.localeCompare(b.vmName) || a.name.localeCompare(b.name));
    return items;
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

async function ensureScheduleRb(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
  names: ReturnType<typeof snapshotScheduleObjectNames>,
): Promise<void> {
  const { core, rbac } = getClusterClients(cluster);
  const labels = scheduleLabels(vmName, names.configMap);

  try {
    await core.createNamespacedServiceAccount({
      namespace,
      body: {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: { name: names.serviceAccount, namespace, labels },
      },
    });
  } catch (err) {
    if (!isAlreadyExists(err)) {
      throw new Error(
        `Failed to create ServiceAccount ${namespace}/${names.serviceAccount}: ${formatError(err)}`,
        { cause: err },
      );
    }
  }

  const roleBody = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: { name: names.role, namespace, labels },
    rules: [
      {
        apiGroups: [""],
        resources: ["configmaps"],
        resourceNames: [names.configMap],
        verbs: ["get", "update", "patch"],
      },
      {
        apiGroups: ["snapshot.kubevirt.io"],
        resources: ["virtualmachinesnapshots"],
        verbs: ["get", "list", "create", "delete"],
      },
      {
        apiGroups: ["kubevirt.io"],
        resources: ["virtualmachines"],
        resourceNames: [vmName],
        verbs: ["get"],
      },
    ],
  };

  try {
    await rbac.createNamespacedRole({ namespace, body: roleBody });
  } catch (err) {
    if (isAlreadyExists(err)) {
      await rbac.replaceNamespacedRole({
        name: names.role,
        namespace,
        body: roleBody,
      });
    } else {
      throw new Error(
        `Failed to create Role ${namespace}/${names.role}: ${formatError(err)}`,
        { cause: err },
      );
    }
  }

  const rbBody = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name: names.role, namespace, labels },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: names.role,
    },
    subjects: [
      { kind: "ServiceAccount", name: names.serviceAccount, namespace },
    ],
  };

  try {
    await rbac.createNamespacedRoleBinding({ namespace, body: rbBody });
  } catch (err) {
    if (isAlreadyExists(err)) {
      await rbac.replaceNamespacedRoleBinding({
        name: names.role,
        namespace,
        body: rbBody,
      });
    } else {
      throw new Error(
        `Failed to create RoleBinding ${namespace}/${names.role}: ${formatError(err)}`,
        { cause: err },
      );
    }
  }
}

function buildCronJobManifest(input: {
  namespace: string;
  vmName: string;
  names: ReturnType<typeof snapshotScheduleObjectNames>;
  cron: string;
  enabled: boolean;
  image: string;
}): Record<string, unknown> {
  const labels = scheduleLabels(input.vmName, input.names.configMap);
  return {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: {
      name: input.names.cronJob,
      namespace: input.namespace,
      labels,
    },
    spec: {
      // Cron is interpreted in UTC when timeZone is omitted (portable across clusters).
      schedule: input.cron,
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 1,
      failedJobsHistoryLimit: 3,
      suspend: !input.enabled,
      jobTemplate: {
        metadata: { labels },
        spec: {
          backoffLimit: 1,
          activeDeadlineSeconds: 900,
          template: {
            metadata: { labels },
            spec: {
              serviceAccountName: input.names.serviceAccount,
              restartPolicy: "Never",
              containers: [
                {
                  name: "snapshot",
                  image: input.image,
                  imagePullPolicy: "IfNotPresent",
                  command: ["./node_modules/.bin/tsx", "./scripts/snapshot-run.ts"],
                  env: [
                    {
                      name: "KMC_SNAPSHOT_NAMESPACE",
                      value: input.namespace,
                    },
                    {
                      name: "KMC_SNAPSHOT_SCHEDULE",
                      value: input.names.configMap,
                    },
                  ],
                  resources: {
                    requests: { cpu: "50m", memory: "128Mi" },
                    limits: { cpu: "500m", memory: "512Mi" },
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}

async function upsertCronJob(
  cluster: ClusterId,
  namespace: string,
  body: Record<string, unknown>,
  cronJobName: string,
): Promise<void> {
  const { custom } = getClusterClients(cluster);
  const group = "batch";
  const version = "v1";
  const plural = "cronjobs";

  const withResourceVersion = (
    existing: unknown,
  ): Record<string, unknown> => {
    let rv: string | undefined;
    if (existing && typeof existing === "object" && "metadata" in existing) {
      const meta = (existing as { metadata?: unknown }).metadata;
      if (meta && typeof meta === "object" && "resourceVersion" in meta) {
        const raw = (meta as { resourceVersion?: unknown }).resourceVersion;
        if (typeof raw === "string" && raw.trim()) rv = raw;
      }
    }
    if (!rv) return body;
    const bodyMeta =
      body.metadata && typeof body.metadata === "object"
        ? (body.metadata as Record<string, unknown>)
        : {};
    return {
      ...body,
      metadata: {
        ...bodyMeta,
        resourceVersion: rv,
      },
    };
  };

  try {
    const existing = await custom.getNamespacedCustomObject({
      group,
      version,
      namespace,
      plural,
      name: cronJobName,
    });
    // Replace full object so schedule/suspend/image stay in sync.
    await custom.replaceNamespacedCustomObject({
      group,
      version,
      namespace,
      plural,
      name: cronJobName,
      body: withResourceVersion(existing),
    });
  } catch (err) {
    if (!isNotFound(err)) {
      // Create path when get fails for other reasons is risky; only create on 404.
      throw new Error(
        `Failed to read CronJob ${namespace}/${cronJobName}: ${formatError(err)}`,
        { cause: err },
      );
    }
    try {
      await custom.createNamespacedCustomObject({
        group,
        version,
        namespace,
        plural,
        body,
      });
    } catch (createErr) {
      if (isAlreadyExists(createErr)) {
        const existing = await custom.getNamespacedCustomObject({
          group,
          version,
          namespace,
          plural,
          name: cronJobName,
        });
        await custom.replaceNamespacedCustomObject({
          group,
          version,
          namespace,
          plural,
          name: cronJobName,
          body: withResourceVersion(existing),
        });
      } else {
        throw new Error(
          `Failed to create CronJob ${namespace}/${cronJobName}: ${formatError(createErr)}`,
          { cause: createErr },
        );
      }
    }
  }
}

/**
 * Create or update the single per-VM snapshot schedule (ConfigMap + RBAC + CronJob).
 */
export async function upsertVmSnapshotSchedule(
  input: UpsertVmSnapshotScheduleRequest,
): Promise<VmSnapshotScheduleSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.vmName?.trim()) throw new Error("vmName is required");

  const cronErr = validateCronExpression(input.cron);
  if (cronErr) throw new Error(cronErr);
  const retainErr = validateRetain(input.retain);
  if (retainErr) throw new Error(retainErr);

  const image = scheduleImage();
  const names = snapshotScheduleObjectNames(input.vmName);
  const enabled = input.enabled !== false;
  const cron = input.cron.trim();
  const failureDeadline = input.failureDeadline?.trim() || undefined;

  const doc: SnapshotScheduleDoc = {
    apiVersion: "kmc.ianunruh.com/v1",
    kind: "VmSnapshotSchedule",
    vmName: input.vmName.trim(),
    enabled,
    cron,
    retain: input.retain,
    failureDeadline,
    cronJobName: names.cronJob,
  };

  await ensureScheduleRb(input.cluster, input.namespace, doc.vmName, names);

  const { core } = getClusterClients(input.cluster);
  const labels = scheduleLabels(doc.vmName, names.configMap);

  let existing:
    | Awaited<ReturnType<typeof core.readNamespacedConfigMap>>
    | null = null;
  try {
    existing = await core.readNamespacedConfigMap({
      name: names.configMap,
      namespace: input.namespace,
    });
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(
        `Failed to read schedule ConfigMap ${input.namespace}/${names.configMap}: ${formatError(err)}`,
        { cause: err },
      );
    }
  }

  const data = {
    [KMC_SNAPSHOT_SCHEDULE_DATA_KEY]: JSON.stringify(doc, null, 2),
  };

  if (existing) {
    await core.replaceNamespacedConfigMap({
      name: names.configMap,
      namespace: input.namespace,
      body: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: names.configMap,
          namespace: input.namespace,
          labels,
          // Preserve runner status annotations.
          annotations: existing.metadata?.annotations,
          resourceVersion: existing.metadata?.resourceVersion,
        },
        data,
      },
    });
  } else {
    try {
      await core.createNamespacedConfigMap({
        namespace: input.namespace,
        body: {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name: names.configMap,
            namespace: input.namespace,
            labels,
          },
          data,
        },
      });
    } catch (err) {
      if (!isAlreadyExists(err)) {
        throw new Error(
          `Failed to create schedule ConfigMap ${input.namespace}/${names.configMap}: ${formatError(err)}`,
          { cause: err },
        );
      }
      const raced = await core.readNamespacedConfigMap({
        name: names.configMap,
        namespace: input.namespace,
      });
      await core.replaceNamespacedConfigMap({
        name: names.configMap,
        namespace: input.namespace,
        body: {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name: names.configMap,
            namespace: input.namespace,
            labels,
            annotations: raced.metadata?.annotations,
            resourceVersion: raced.metadata?.resourceVersion,
          },
          data,
        },
      });
    }
  }

  const cronJobBody = buildCronJobManifest({
    namespace: input.namespace,
    vmName: doc.vmName,
    names,
    cron,
    enabled,
    image,
  });
  await upsertCronJob(input.cluster, input.namespace, cronJobBody, names.cronJob);

  const summary = await getVmSnapshotSchedule(
    input.cluster,
    input.namespace,
    doc.vmName,
  );
  if (!summary) {
    throw new Error("Schedule was written but could not be re-read");
  }
  return summary;
}

/**
 * Delete schedule policy + CronJob + SA/Role/RoleBinding.
 * Does not delete existing VirtualMachineSnapshots.
 */
export async function deleteVmSnapshotSchedule(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<void> {
  if (!cluster?.trim()) throw new Error("cluster is required");
  if (!namespace?.trim()) throw new Error("namespace is required");
  if (!vmName?.trim()) throw new Error("vmName is required");

  const names = snapshotScheduleObjectNames(vmName);
  const { core, rbac, custom } = getClusterClients(cluster);

  const ignore = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      if (!isNotFound(err)) {
        console.error("deleteVmSnapshotSchedule:", formatError(err));
      }
    }
  };

  await ignore(() =>
    custom.deleteNamespacedCustomObject({
      group: "batch",
      version: "v1",
      namespace,
      plural: "cronjobs",
      name: names.cronJob,
    }),
  );
  await ignore(() =>
    core.deleteNamespacedConfigMap({ name: names.configMap, namespace }),
  );
  await ignore(() =>
    rbac.deleteNamespacedRoleBinding({ name: names.role, namespace }),
  );
  await ignore(() => rbac.deleteNamespacedRole({ name: names.role, namespace }));
  await ignore(() =>
    core.deleteNamespacedServiceAccount({
      name: names.serviceAccount,
      namespace,
    }),
  );
}

