import { formatError } from "~/lib/errors";
import type { ClusterId } from "~/lib/types";
import { KMC_LABEL_BACKEND_GROUP } from "~/lib/k8s/constants";
import { getClusterClients } from "~/lib/k8s/clients.server";

interface KubeVm {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    resourceVersion?: string;
  };
  spec?: {
    template?: {
      metadata?: {
        labels?: Record<string, string>;
      };
      spec?: {
        networks?: Array<{ pod?: unknown; multus?: unknown }>;
      };
    };
  };
  status?: {
    printableStatus?: string;
    ready?: boolean;
  };
}

function isNotFound(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  return message.includes("404") || message.includes("not found");
}

function isConflict(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  return message.includes("409") || message.includes("conflict");
}

async function fetchVm(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<KubeVm> {
  const { custom } = getClusterClients(cluster);
  return (await custom.getNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace,
    plural: "virtualmachines",
    name,
  })) as KubeVm;
}

/**
 * Set or clear kmc.ianunruh.com/backend-group on VM metadata + pod template.
 * Template labels are what virt-launcher pods carry for Service selection.
 */
async function setBackendGroupLabel(opts: {
  cluster: ClusterId;
  namespace: string;
  vmName: string;
  groupId: string | null;
}): Promise<void> {
  const { custom } = getClusterClients(opts.cluster);
  const attempt = async (): Promise<void> => {
    const existing = await fetchVm(opts.cluster, opts.namespace, opts.vmName);
    const body = structuredClone(existing) as KubeVm & Record<string, unknown>;
    delete (body as { status?: unknown }).status;

    body.metadata = body.metadata ?? {};
    body.metadata.labels = { ...(body.metadata.labels ?? {}) };
    body.spec = body.spec ?? {};
    body.spec.template = body.spec.template ?? {};
    body.spec.template.metadata = body.spec.template.metadata ?? {};
    body.spec.template.metadata.labels = {
      ...(body.spec.template.metadata.labels ?? {}),
    };

    if (opts.groupId) {
      body.metadata.labels[KMC_LABEL_BACKEND_GROUP] = opts.groupId;
      body.spec.template.metadata.labels[KMC_LABEL_BACKEND_GROUP] =
        opts.groupId;
    } else {
      delete body.metadata.labels[KMC_LABEL_BACKEND_GROUP];
      delete body.spec.template.metadata.labels[KMC_LABEL_BACKEND_GROUP];
    }

    await custom.replaceNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace: opts.namespace,
      plural: "virtualmachines",
      name: opts.vmName,
      body,
    });
  };

  try {
    await attempt();
  } catch (err) {
    if (!isConflict(err)) {
      throw new Error(
        `Failed to update backend group on VM "${opts.vmName}": ${formatError(err)}`,
        { cause: err },
      );
    }
    try {
      await attempt();
    } catch (retryErr) {
      throw new Error(
        `Failed to update backend group on VM "${opts.vmName}": ${formatError(retryErr)}`,
        { cause: retryErr },
      );
    }
  }
}

/** Stamp group label on all members; rolls back stamps on partial failure. */
export async function stampBackendGroup(opts: {
  cluster: ClusterId;
  namespace: string;
  groupId: string;
  vmNames: string[];
}): Promise<void> {
  const stamped: string[] = [];
  try {
    for (const vmName of opts.vmNames) {
      // Ensure VM exists first
      try {
        await fetchVm(opts.cluster, opts.namespace, vmName);
      } catch (err) {
        if (isNotFound(err)) {
          throw new Error(
            `VirtualMachine "${opts.namespace}/${vmName}" not found`,
          );
        }
        throw new Error(formatError(err), { cause: err });
      }
      await setBackendGroupLabel({
        cluster: opts.cluster,
        namespace: opts.namespace,
        vmName,
        groupId: opts.groupId,
      });
      stamped.push(vmName);
    }
  } catch (err) {
    // Best-effort unstamp of already-stamped members
    for (const vmName of stamped) {
      try {
        await setBackendGroupLabel({
          cluster: opts.cluster,
          namespace: opts.namespace,
          vmName,
          groupId: null,
        });
      } catch {
        // ignore
      }
    }
    throw err;
  }
}

/** Remove group label from the given VMs (ignore missing VMs). */
export async function unstampBackendGroup(opts: {
  cluster: ClusterId;
  namespace: string;
  vmNames: string[];
}): Promise<void> {
  for (const vmName of opts.vmNames) {
    try {
      await setBackendGroupLabel({
        cluster: opts.cluster,
        namespace: opts.namespace,
        vmName,
        groupId: null,
      });
    } catch (err) {
      if (isNotFound(err)) continue;
      // Still try remaining VMs; surface first hard error at end if needed
      throw err;
    }
  }
}

/**
 * List VMs in the namespace that currently carry the backend-group label.
 * Used when deleting a group backend if the annotation is stale.
 */
export async function listVmsWithBackendGroup(
  cluster: ClusterId,
  namespace: string,
  groupId: string,
): Promise<string[]> {
  const { custom } = getClusterClients(cluster);
  const res = (await custom.listNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace,
    plural: "virtualmachines",
    labelSelector: `${KMC_LABEL_BACKEND_GROUP}=${groupId}`,
  })) as { items?: Array<{ metadata?: { name?: string } }> };

  return (res.items ?? [])
    .map((vm) => vm.metadata?.name)
    .filter((n): n is string => Boolean(n))
    .sort();
}
