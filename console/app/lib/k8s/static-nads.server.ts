import { formatError } from "~/lib/errors";
import type { ClusterId } from "~/lib/types";
import type { IpPoolConfig } from "./cluster-config.server";
import { getClusterClients } from "./clients.server";
import {
  KMC_LABEL_IP_POOL,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_VLAN,
  KMC_MANAGED_BY,
  KMC_RESOURCE_NETWORK,
  MANAGED_BY_LABEL,
} from "./constants";
import {
  findIpPoolForMultus,
  multusNetworkMatches,
  parseMultusNetworkRef,
} from "~/lib/ipam/pools.server";

function isNotFound(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  return message.includes("404") || message.includes("not found");
}

function isAlreadyExists(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  return message.includes("409") || message.includes("already exists");
}

/** Bare NAD name from pool.multusNetwork (`external` or `ns/external` → `external`). */
export function nadNameFromMultusRef(multusNetwork: string): string {
  const raw = multusNetwork.trim();
  if (!raw) return "";
  return raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
}

function buildStaticNadBody(
  pool: IpPoolConfig,
  namespace: string,
  nadName: string,
) {
  const cni = pool.cni;
  if (!cni) {
    throw new Error(`IP pool "${pool.id}" has no cni template`);
  }

  const config: Record<string, unknown> = {
    cniVersion: "0.3.1",
    name: nadName,
    type: cni.type,
    bridge: cni.bridge,
    ipam: {},
  };
  if (cni.vlan != null) {
    config.vlan = cni.vlan;
  }

  const labels: Record<string, string> = {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_NETWORK,
    [KMC_LABEL_IP_POOL]: pool.id,
  };
  if (cni.vlan != null) {
    labels[KMC_LABEL_VLAN] = String(cni.vlan);
  }

  return {
    apiVersion: "k8s.cni.cncf.io/v1",
    kind: "NetworkAttachmentDefinition",
    metadata: {
      name: nadName,
      namespace,
      labels,
    },
    spec: {
      config: JSON.stringify(config),
    },
  };
}

/**
 * If `multusNetworkName` matches a static ipPool with a `cni` template, ensure
 * the Multus NAD exists in the VM's namespace. No-op for VPC NADs, pools without
 * cni, or cross-namespace Multus refs.
 */
export async function ensureStaticMultusNad(
  cluster: ClusterId,
  namespace: string,
  multusNetworkName: string,
): Promise<void> {
  const ns = namespace.trim();
  const selected = multusNetworkName.trim();
  if (!cluster?.trim() || !ns || !selected) return;

  const ref = parseMultusNetworkRef(selected, ns);
  // Only materialize local NADs; explicit other-ns/name is operator-managed.
  if (ref.namespace !== ns) return;

  const pool = findIpPoolForMultus(cluster, selected);
  if (!pool?.cni) return;

  const nadName = nadNameFromMultusRef(pool.multusNetwork);
  if (!nadName || !multusNetworkMatches(pool.multusNetwork, selected)) return;
  // Ensure the bare name we create matches what Multus will resolve for this ref.
  if (ref.name !== nadName) return;

  const { custom } = getClusterClients(cluster);
  try {
    await custom.getNamespacedCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      namespace: ns,
      plural: "network-attachment-definitions",
      name: nadName,
    });
    return;
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(
        `Failed to check Multus NAD ${ns}/${nadName}: ${formatError(err)}`,
        { cause: err },
      );
    }
  }

  const body = buildStaticNadBody(pool, ns, nadName);
  try {
    await custom.createNamespacedCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      namespace: ns,
      plural: "network-attachment-definitions",
      body,
    });
  } catch (err) {
    if (isAlreadyExists(err)) return;
    throw new Error(
      `Failed to create Multus NAD ${ns}/${nadName} for ip pool "${pool.id}": ${formatError(err)}`,
      { cause: err },
    );
  }
}

/** Ensure static Multus NADs for every attachment name (deduped). */
export async function ensureStaticMultusNads(
  cluster: ClusterId,
  namespace: string,
  multusNetworkNames: string[],
): Promise<void> {
  const seen = new Set<string>();
  for (const name of multusNetworkNames) {
    const key = name.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    await ensureStaticMultusNad(cluster, namespace, key);
  }
}
