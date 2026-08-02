/**
 * Client for kmc.ianunruh.com/v1alpha1 networking CRDs (control plane).
 * Console creates/patches/deletes these; the Go controller reconciles.
 */
import { formatError } from "~/lib/errors";
import type { ClusterId } from "~/lib/types";
import { getClusterClients } from "~/lib/k8s/clients.server";
import { KMC_LABEL_NAMESPACE, KMC_MANAGED_BY, MANAGED_BY_LABEL } from "~/lib/k8s/constants";

export const KMC_API_GROUP = "kmc.ianunruh.com";
export const KMC_API_VERSION = "v1alpha1";
export const KMC_API = `${KMC_API_GROUP}/${KMC_API_VERSION}`;

export const PLURAL_VPCS = "vpcs";
export const PLURAL_ROUTERS = "routers";
export const PLURAL_FLOATING_IPS = "floatingips";
export const PLURAL_PORT_FORWARDS = "portforwards";
export const PLURAL_IP_ADDRESSES = "ipaddresses";
export const PLURAL_VLAN_POOLS = "vlanpools";
export const PLURAL_IP_POOLS = "ippools";

export type LocalObjectRef = { name: string };

export type ObjectMeta = {
  name?: string;
  generateName?: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  generation?: number;
};

export type Condition = {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  observedGeneration?: number;
};

/** Map CR status.conditions into the shared console condition shape. */
export function mapCrConditions(
  conditions?: Condition[],
): Array<{
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}> {
  return (conditions ?? []).map((c) => ({
    type: c.type ?? "Unknown",
    status: c.status ?? "Unknown",
    reason: c.reason,
    message: c.message,
    lastTransitionTime: c.lastTransitionTime,
  }));
}

// --- VPC ---

export type VpcCr = {
  apiVersion?: string;
  kind?: string;
  metadata?: ObjectMeta;
  spec?: {
    vlanPoolRef?: LocalObjectRef;
    cidr?: string;
    gateway?: string;
    dns?: string[];
    description?: string;
  };
  status?: {
    phase?: string;
    vlan?: number;
    bridge?: string;
    networkAttachmentReady?: boolean;
    routerRef?: LocalObjectRef;
    observedGeneration?: number;
    conditions?: Condition[];
  };
};

// --- Router ---

export type RouterVpcAttachment = {
  name: string;
  gateway?: string;
};

export type RouterExternalSpec = {
  multusNetwork: string;
  address?: string;
  snat?: boolean;
};

export type RouterImageRef = {
  kind?: string;
  namespace: string;
  name: string;
};

export type RouterApplianceSpec = {
  image: RouterImageRef;
  instanceType?: string;
  cpuCores?: number;
  memory?: string;
  diskSize: string;
  storageClass?: string;
  sshPublicKeys: string[];
  runStrategy?: string;
};

export type RouterCr = {
  apiVersion?: string;
  kind?: string;
  metadata?: ObjectMeta;
  spec?: {
    vpcs?: RouterVpcAttachment[];
    external?: RouterExternalSpec | null;
    appliance?: RouterApplianceSpec;
  };
  status?: {
    phase?: string;
    policyConfigMap?: string;
    policyGeneration?: number;
    interfaces?: Array<{
      vpc?: string;
      cidr?: string;
      gateway?: string;
      mac?: string;
      domain?: string;
    }>;
    external?: {
      multusNetwork?: string;
      primaryCidr?: string;
      gateway?: string;
      mac?: string;
      snat?: boolean;
    };
    vmName?: string;
    vmStatus?: string;
    vmReady?: boolean;
    vmMissing?: boolean;
    agent?: {
      status?: string;
      observedGeneration?: string;
      lastError?: string;
      appliedAt?: string;
      heartbeatAt?: string;
      version?: string;
    };
    observedGeneration?: number;
    conditions?: Condition[];
  };
};

// --- FloatingIP ---

export type FloatingIpCr = {
  apiVersion?: string;
  kind?: string;
  metadata?: ObjectMeta;
  spec?: {
    poolRef?: { kind: string; name: string };
    address?: string;
    vpcRef?: LocalObjectRef;
    routerRef?: LocalObjectRef;
    privateAddress?: string;
    targetVM?: LocalObjectRef;
  };
  status?: {
    phase?: string;
    address?: string;
    prefixLength?: number;
    programmed?: boolean;
    observedGeneration?: number;
    conditions?: Condition[];
  };
};

// --- PortForward ---

export type PortForwardCr = {
  apiVersion?: string;
  kind?: string;
  metadata?: ObjectMeta;
  spec?: {
    vpcRef?: LocalObjectRef;
    routerRef?: LocalObjectRef;
    publicAddress?: string;
    publicPort?: number;
    privateAddress?: string;
    privatePort?: number;
    protocol?: string;
    targetVM?: LocalObjectRef;
  };
  status?: {
    phase?: string;
    programmed?: boolean;
    observedGeneration?: number;
    conditions?: Condition[];
  };
};

// --- VLANPool / IPPool ---

export type VlanPoolCr = {
  apiVersion?: string;
  kind?: string;
  metadata?: ObjectMeta;
  spec?: {
    start?: number;
    end?: number;
    bridge?: string;
    dns?: string[];
    exclude?: number[];
  };
  status?: {
    phase?: string;
    allocated?: number;
    available?: number;
  };
};

export type IpPoolCr = {
  apiVersion?: string;
  kind?: string;
  metadata?: ObjectMeta;
  spec?: {
    multusNetwork?: string;
    cidr?: string;
    gateway?: string;
    dns?: string[];
    exclude?: string[];
    start?: string;
    end?: string;
    interface?: string;
    cni?: {
      type?: string;
      bridge?: string;
      vlan?: number;
    };
  };
  status?: {
    phase?: string;
  };
};

// --- IPAddress ---

export type IpAddressCr = {
  apiVersion?: string;
  kind?: string;
  metadata?: ObjectMeta;
  spec?: {
    address?: string;
    prefixLength?: number;
    poolRef?: { kind: string; name: string };
    claimRef?: {
      apiVersion?: string;
      kind?: string;
      name?: string;
      namespace?: string;
    };
    interface?: {
      mac?: string;
      hostname?: string;
    };
  };
  status?: {
    phase?: string;
    gateway?: string;
    dns?: string[];
  };
};

export function isNotFoundError(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  if (message.includes("404") || message.includes("not found")) return true;
  const code = apiStatusCode(err);
  return code === 404;
}

export function isAlreadyExistsError(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  if (message.includes("already exists") || message.includes("alreadyexists")) {
    return true;
  }
  return apiStatusCode(err) === 409;
}

export function isForbiddenError(err: unknown): boolean {
  if (apiStatusCode(err) === 403) return true;
  const message = formatError(err).toLowerCase();
  return message.includes("forbidden");
}

function apiStatusCode(err: unknown): number | undefined {
  const e = err as {
    statusCode?: number;
    code?: number | string;
    response?: { statusCode?: number; status?: number };
  };
  const n =
    e?.statusCode ??
    e?.response?.statusCode ??
    e?.response?.status ??
    (typeof e?.code === "number" ? e.code : undefined);
  if (typeof n === "number" && n > 0) return n;
  const msg = formatError(err);
  const httpCode = msg.match(/HTTP-Code:\s*(\d+)/i);
  if (httpCode) {
    const parsed = Number(httpCode[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function custom(cluster: ClusterId) {
  return getClusterClients(cluster).custom;
}

// --- Generic list/get/create/delete/patch ---

export async function listClusterCustomObjects<T>(
  cluster: ClusterId,
  plural: string,
  opts?: { labelSelector?: string },
): Promise<T[]> {
  try {
    const res = (await custom(cluster).listClusterCustomObject({
      group: KMC_API_GROUP,
      version: KMC_API_VERSION,
      plural,
      ...(opts?.labelSelector ? { labelSelector: opts.labelSelector } : {}),
    })) as { items?: T[] };
    return res.items ?? [];
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

export async function listNamespacedCustomObjects<T>(
  cluster: ClusterId,
  namespace: string,
  plural: string,
  opts?: { labelSelector?: string },
): Promise<T[]> {
  try {
    const res = (await custom(cluster).listNamespacedCustomObject({
      group: KMC_API_GROUP,
      version: KMC_API_VERSION,
      namespace,
      plural,
      ...(opts?.labelSelector ? { labelSelector: opts.labelSelector } : {}),
    })) as { items?: T[] };
    return res.items ?? [];
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

export async function getNamespacedCustomObject<T>(
  cluster: ClusterId,
  namespace: string,
  plural: string,
  name: string,
): Promise<T> {
  return (await custom(cluster).getNamespacedCustomObject({
    group: KMC_API_GROUP,
    version: KMC_API_VERSION,
    namespace,
    plural,
    name,
  })) as T;
}

export async function getClusterCustomObject<T>(
  cluster: ClusterId,
  plural: string,
  name: string,
): Promise<T> {
  return (await custom(cluster).getClusterCustomObject({
    group: KMC_API_GROUP,
    version: KMC_API_VERSION,
    plural,
    name,
  })) as T;
}

export async function createNamespacedCustomObject<T>(
  cluster: ClusterId,
  namespace: string,
  plural: string,
  body: unknown,
): Promise<T> {
  return (await custom(cluster).createNamespacedCustomObject({
    group: KMC_API_GROUP,
    version: KMC_API_VERSION,
    namespace,
    plural,
    body,
  })) as T;
}

export async function deleteNamespacedCustomObject(
  cluster: ClusterId,
  namespace: string,
  plural: string,
  name: string,
): Promise<void> {
  try {
    await custom(cluster).deleteNamespacedCustomObject({
      group: KMC_API_GROUP,
      version: KMC_API_VERSION,
      namespace,
      plural,
      name,
    });
  } catch (err) {
    if (isNotFoundError(err)) return;
    throw err;
  }
}

export async function replaceNamespacedCustomObject<T>(
  cluster: ClusterId,
  namespace: string,
  plural: string,
  name: string,
  body: unknown,
): Promise<T> {
  return (await custom(cluster).replaceNamespacedCustomObject({
    group: KMC_API_GROUP,
    version: KMC_API_VERSION,
    namespace,
    plural,
    name,
    body,
  })) as T;
}

export async function patchNamespacedCustomObject<T>(
  cluster: ClusterId,
  namespace: string,
  plural: string,
  name: string,
  body: unknown,
): Promise<T> {
  return (await custom(cluster).patchNamespacedCustomObject({
    group: KMC_API_GROUP,
    version: KMC_API_VERSION,
    namespace,
    plural,
    name,
    body,
  })) as T;
}

/** Managed-by labels for console-created tenant CRs. */
export function kmcManagedLabels(extra?: Record<string, string>): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    ...extra,
  };
}

export function ownerAnnotation(login?: string | null): Record<string, string> {
  if (!login?.trim()) return {};
  return { [`${KMC_LABEL_NAMESPACE}/owner`]: login.trim() };
}

/** DNS-1123 object name from IPv4 (10.40.1.20 → 10-40-1-20). */
export function ipv4ObjectName(address: string): string {
  return address.trim().replaceAll(".", "-");
}

export function floatingIpObjectName(publicAddress: string): string {
  return ipv4ObjectName(publicAddress);
}

export function portForwardObjectName(
  publicAddress: string,
  protocol: string,
  publicPort: number,
): string {
  const proto = protocol.toLowerCase() === "udp" ? "udp" : "tcp";
  return `pf-${ipv4ObjectName(publicAddress)}-${proto}-${publicPort}`.slice(0, 63);
}
