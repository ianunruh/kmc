import { formatError } from "~/lib/errors";
import type {
  ClusterId,
  CreateVmRestoreRequest,
  CreateVmSnapshotRequest,
  VmSnapshotSummary,
} from "~/lib/types";
import {
  KMC_LABEL_RESOURCE,
  KMC_LABEL_SCHEDULE,
  KMC_LABEL_SNAPSHOT_KIND,
  KMC_LABEL_VM,
  KMC_MANAGED_BY,
  KMC_RESOURCE_VM_SNAPSHOT,
  KMC_SNAPSHOT_KIND_MANUAL,
  KMC_SNAPSHOT_KIND_SCHEDULED,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import { getClusterClients } from "~/lib/k8s/clients.server";

const SNAPSHOT_GROUP = "snapshot.kubevirt.io";
const SNAPSHOT_VERSION = "v1beta1";
const SNAPSHOTS_PLURAL = "virtualmachinesnapshots";
const RESTORES_PLURAL = "virtualmachinerestores";

interface KubeVmSnapshot {
  metadata?: {
    name?: string;
    namespace?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    source?: {
      apiGroup?: string;
      kind?: string;
      name?: string;
    };
    failureDeadline?: string;
  };
  status?: {
    phase?: string;
    readyToUse?: boolean;
    indications?: string[];
    error?: { message?: string; time?: string };
    virtualMachineSnapshotContentName?: string;
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
    }>;
  };
}

function dnsLabel(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 63).replace(/-+$/g, "") || "snap";
}

/** Timestamp suffix safe for DNS labels: 20260724-120530 */
function timeSuffix(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

function defaultSnapshotName(vmName: string): string {
  // Keep room for timestamp suffix under 63 chars.
  const base = dnsLabel(vmName).slice(0, 40).replace(/-+$/g, "") || "vm";
  return dnsLabel(`${base}-${timeSuffix()}`);
}

function defaultRestoreName(vmName: string): string {
  const base = dnsLabel(vmName).slice(0, 32).replace(/-+$/g, "") || "vm";
  return dnsLabel(`restore-${base}-${timeSuffix()}`);
}

function mapSummary(cluster: ClusterId, snap: KubeVmSnapshot): VmSnapshotSummary {
  const errMsg =
    snap.status?.error?.message?.trim() ||
    snap.status?.conditions?.find((c) => c.type === "Progressing" && c.status === "False")
      ?.message ||
    snap.status?.conditions?.find((c) => c.type === "Failure")?.message;

  const labels = snap.metadata?.labels ?? {};
  const scheduleName = labels[KMC_LABEL_SCHEDULE]?.trim() || undefined;
  const snapshotKind =
    labels[KMC_LABEL_SNAPSHOT_KIND]?.trim() ||
    (scheduleName ? KMC_SNAPSHOT_KIND_SCHEDULED : undefined);

  return {
    cluster,
    namespace: snap.metadata?.namespace ?? "default",
    name: snap.metadata?.name ?? "unknown",
    vmName:
      snap.spec?.source?.name?.trim() ||
      labels[KMC_LABEL_VM]?.trim() ||
      "",
    phase: snap.status?.phase ?? "Unknown",
    readyToUse: snap.status?.readyToUse === true,
    indications: snap.status?.indications ?? [],
    age: snap.metadata?.creationTimestamp ?? "",
    error: errMsg?.trim() || undefined,
    contentName: snap.status?.virtualMachineSnapshotContentName,
    scheduleName,
    snapshotKind,
  };
}

/**
 * List VirtualMachineSnapshots in a namespace, optionally filtered to one VM.
 */
export async function listVmSnapshots(
  cluster: ClusterId,
  namespace: string,
  vmName?: string,
): Promise<VmSnapshotSummary[]> {
  if (!cluster?.trim()) throw new Error("cluster is required");
  if (!namespace?.trim()) throw new Error("namespace is required");

  const { custom } = getClusterClients(cluster);
  try {
    const res = (await custom.listNamespacedCustomObject({
      group: SNAPSHOT_GROUP,
      version: SNAPSHOT_VERSION,
      namespace,
      plural: SNAPSHOTS_PLURAL,
    })) as { items?: KubeVmSnapshot[] };

    let items = (res.items ?? []).map((s) => mapSummary(cluster, s));
    const want = vmName?.trim();
    if (want) {
      items = items.filter((s) => s.vmName === want);
    }
    items.sort((a, b) => {
      // Newest first when ages are ISO timestamps
      const ta = a.age || "";
      const tb = b.age || "";
      if (ta !== tb) return tb.localeCompare(ta);
      return a.name.localeCompare(b.name);
    });
    return items;
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export async function getVmSnapshot(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<VmSnapshotSummary> {
  const { custom } = getClusterClients(cluster);
  try {
    const snap = (await custom.getNamespacedCustomObject({
      group: SNAPSHOT_GROUP,
      version: SNAPSHOT_VERSION,
      namespace,
      plural: SNAPSHOTS_PLURAL,
      name,
    })) as KubeVmSnapshot;
    return mapSummary(cluster, snap);
  } catch (err) {
    const message = formatError(err);
    if (message.includes("404") || message.toLowerCase().includes("not found")) {
      throw new Response("VirtualMachineSnapshot not found", { status: 404 });
    }
    throw new Error(message, { cause: err });
  }
}

export async function createVmSnapshot(
  input: CreateVmSnapshotRequest,
): Promise<VmSnapshotSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.vmName?.trim()) throw new Error("vmName is required");

  const name = input.name?.trim()
    ? dnsLabel(input.name.trim())
    : defaultSnapshotName(input.vmName);

  if (!name || name.length > 63) {
    throw new Error("snapshot name must be a DNS label (≤63 characters)");
  }

  const scheduleName = input.scheduleName?.trim() || undefined;
  const labels: Record<string, string> = {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_VM]: input.vmName,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_VM_SNAPSHOT,
    [KMC_LABEL_SNAPSHOT_KIND]: scheduleName
      ? KMC_SNAPSHOT_KIND_SCHEDULED
      : KMC_SNAPSHOT_KIND_MANUAL,
  };
  if (scheduleName) {
    labels[KMC_LABEL_SCHEDULE] = scheduleName;
  }

  const body: Record<string, unknown> = {
    apiVersion: `${SNAPSHOT_GROUP}/${SNAPSHOT_VERSION}`,
    kind: "VirtualMachineSnapshot",
    metadata: {
      name,
      namespace: input.namespace,
      labels,
    },
    spec: {
      source: {
        apiGroup: "kubevirt.io",
        kind: "VirtualMachine",
        name: input.vmName,
      },
      ...(input.failureDeadline?.trim()
        ? { failureDeadline: input.failureDeadline.trim() }
        : {}),
    },
  };

  const { custom } = getClusterClients(input.cluster);
  try {
    const created = (await custom.createNamespacedCustomObject({
      group: SNAPSHOT_GROUP,
      version: SNAPSHOT_VERSION,
      namespace: input.namespace,
      plural: SNAPSHOTS_PLURAL,
      body,
    })) as KubeVmSnapshot;
    return mapSummary(input.cluster, created);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

/**
 * Create a VirtualMachineSnapshot using a pre-built CustomObjectsApi client.
 * Used by the in-cluster CronJob runner (no request-scoped actor).
 */
export async function createVmSnapshotWithClient(
  custom: {
    createNamespacedCustomObject: (args: {
      group: string;
      version: string;
      namespace: string;
      plural: string;
      body: unknown;
    }) => Promise<unknown>;
  },
  input: {
    cluster: ClusterId;
    namespace: string;
    vmName: string;
    name?: string;
    failureDeadline?: string;
    scheduleName: string;
  },
): Promise<VmSnapshotSummary> {
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.vmName?.trim()) throw new Error("vmName is required");
  if (!input.scheduleName?.trim()) throw new Error("scheduleName is required");

  const name = input.name?.trim()
    ? dnsLabel(input.name.trim())
    : defaultSnapshotName(input.vmName);

  if (!name || name.length > 63) {
    throw new Error("snapshot name must be a DNS label (≤63 characters)");
  }

  const body: Record<string, unknown> = {
    apiVersion: `${SNAPSHOT_GROUP}/${SNAPSHOT_VERSION}`,
    kind: "VirtualMachineSnapshot",
    metadata: {
      name,
      namespace: input.namespace,
      labels: {
        [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
        [KMC_LABEL_VM]: input.vmName,
        [KMC_LABEL_RESOURCE]: KMC_RESOURCE_VM_SNAPSHOT,
        [KMC_LABEL_SNAPSHOT_KIND]: KMC_SNAPSHOT_KIND_SCHEDULED,
        [KMC_LABEL_SCHEDULE]: input.scheduleName,
      },
    },
    spec: {
      source: {
        apiGroup: "kubevirt.io",
        kind: "VirtualMachine",
        name: input.vmName,
      },
      ...(input.failureDeadline?.trim()
        ? { failureDeadline: input.failureDeadline.trim() }
        : {}),
    },
  };

  try {
    const created = (await custom.createNamespacedCustomObject({
      group: SNAPSHOT_GROUP,
      version: SNAPSHOT_VERSION,
      namespace: input.namespace,
      plural: SNAPSHOTS_PLURAL,
      body,
    })) as KubeVmSnapshot;
    return mapSummary(input.cluster, created);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

/**
 * List snapshots for a VM using a pre-built client (CronJob runner).
 */
export async function listVmSnapshotsWithClient(
  custom: {
    listNamespacedCustomObject: (args: {
      group: string;
      version: string;
      namespace: string;
      plural: string;
    }) => Promise<unknown>;
  },
  cluster: ClusterId,
  namespace: string,
  vmName?: string,
): Promise<VmSnapshotSummary[]> {
  if (!namespace?.trim()) throw new Error("namespace is required");

  try {
    const res = (await custom.listNamespacedCustomObject({
      group: SNAPSHOT_GROUP,
      version: SNAPSHOT_VERSION,
      namespace,
      plural: SNAPSHOTS_PLURAL,
    })) as { items?: KubeVmSnapshot[] };

    let items = (res.items ?? []).map((s) => mapSummary(cluster, s));
    const want = vmName?.trim();
    if (want) {
      items = items.filter((s) => s.vmName === want);
    }
    items.sort((a, b) => {
      const ta = a.age || "";
      const tb = b.age || "";
      if (ta !== tb) return tb.localeCompare(ta);
      return a.name.localeCompare(b.name);
    });
    return items;
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

/**
 * Delete a snapshot using a pre-built client (CronJob runner prune).
 */
export async function deleteVmSnapshotWithClient(
  custom: {
    deleteNamespacedCustomObject: (args: {
      group: string;
      version: string;
      namespace: string;
      plural: string;
      name: string;
    }) => Promise<unknown>;
  },
  namespace: string,
  name: string,
): Promise<void> {
  try {
    await custom.deleteNamespacedCustomObject({
      group: SNAPSHOT_GROUP,
      version: SNAPSHOT_VERSION,
      namespace,
      plural: SNAPSHOTS_PLURAL,
      name,
    });
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export async function deleteVmSnapshot(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  const { custom } = getClusterClients(cluster);
  try {
    await custom.deleteNamespacedCustomObject({
      group: SNAPSHOT_GROUP,
      version: SNAPSHOT_VERSION,
      namespace,
      plural: SNAPSHOTS_PLURAL,
      name,
    });
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

/**
 * In-place restore from a ready snapshot.
 * Uses StopTarget + InPlace so the VM is stopped and volume names stay stable
 * (important for kmc standalone root DataVolumes).
 */
export async function createVmRestore(
  input: CreateVmRestoreRequest,
): Promise<{ name: string }> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.vmName?.trim()) throw new Error("vmName is required");
  if (!input.snapshotName?.trim()) throw new Error("snapshotName is required");

  let snap: VmSnapshotSummary;
  try {
    snap = await getVmSnapshot(input.cluster, input.namespace, input.snapshotName);
  } catch (err) {
    if (err instanceof Response) {
      throw new Error(`Snapshot ${input.snapshotName} not found`, { cause: err });
    }
    throw err;
  }
  if (!snap.readyToUse) {
    throw new Error(
      `Snapshot ${input.snapshotName} is not ready to use (phase=${snap.phase})`,
    );
  }
  if (snap.vmName && snap.vmName !== input.vmName) {
    throw new Error(
      `Snapshot ${input.snapshotName} belongs to VM ${snap.vmName}, not ${input.vmName}`,
    );
  }

  const name = input.name?.trim()
    ? dnsLabel(input.name.trim())
    : defaultRestoreName(input.vmName);

  const body = {
    apiVersion: `${SNAPSHOT_GROUP}/${SNAPSHOT_VERSION}`,
    kind: "VirtualMachineRestore",
    metadata: {
      name,
      namespace: input.namespace,
      labels: {
        [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
        [KMC_LABEL_VM]: input.vmName,
      },
    },
    spec: {
      target: {
        apiGroup: "kubevirt.io",
        kind: "VirtualMachine",
        name: input.vmName,
      },
      virtualMachineSnapshotName: input.snapshotName,
      targetReadinessPolicy: "StopTarget",
      volumeRestorePolicy: "InPlace",
    },
  };

  const { custom } = getClusterClients(input.cluster);
  try {
    await custom.createNamespacedCustomObject({
      group: SNAPSHOT_GROUP,
      version: SNAPSHOT_VERSION,
      namespace: input.namespace,
      plural: RESTORES_PLURAL,
      body,
    });
    return { name };
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}
