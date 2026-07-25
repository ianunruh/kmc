import { formatError } from "~/lib/errors";
import type {
  AssociateFloatingIpRequest,
  ClusterId,
  DisassociateFloatingIpRequest,
  FloatingIpAssociation,
  FloatingIpSummary,
  ReleaseFloatingIpRequest,
  RouterAgentStatus,
  RouterDetail,
  RouterInterfaceInfo,
  RouterLease,
  RouterSummary,
} from "~/lib/types";
import {
  KMC_ANN_AGENT_APPLIED_AT,
  KMC_ANN_AGENT_HEARTBEAT_AT,
  KMC_ANN_AGENT_LAST_ERROR,
  KMC_ANN_AGENT_OBSERVED_GENERATION,
  KMC_ANN_AGENT_STATUS,
  KMC_ANN_AGENT_VERSION,
  KMC_ANN_FLOATING_IPV4,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_ROLE,
  KMC_LABEL_ROUTER,
  KMC_MANAGED_BY,
  KMC_AGENT_STALE_AFTER_MS,
  KMC_RESOURCE_ROUTER_POLICY,
  KMC_ROLE_ROUTER,
  KMC_ROUTER_AGENT_SCRIPT_KEY,
  KMC_ROUTER_POLICY_DATA_KEY,
  KMC_ROUTER_POLICY_LABEL_SELECTOR,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import {
  clusterNetworkCidrList,
  getClusterNetwork,
  requireClusterIdentity,
  type ClusterNetworkConfig,
} from "~/lib/k8s/cluster-config.server";
import { getClusterClients } from "~/lib/k8s/clients.server";
import { formatAge } from "~/lib/format";
import {
  addressFromIpv4Annotation,
  containsIpv4,
  parseCidr,
} from "~/lib/ipam/cidr";
import { IPAM_ANNOTATION_IPV4 } from "~/lib/ipam/constants";
import {
  allocateIpv4ForMultus,
  findIpPoolForMultus,
  parseIpv4AnnotationList,
} from "~/lib/ipam/pools.server";
import { getRouterAgentScript } from "~/vpcs/router-agent-script";

/** JSON document stored in the router policy ConfigMap. */
export type RouterPolicyDoc = {
  apiVersion: "kmc.ianunruh.com/v1alpha1";
  kind: "RouterPolicy";
  metadata: {
    name: string;
    namespace: string;
    generation: number;
  };
  interfaces: Array<{
    vpc: string;
    cidr: string;
    gateway: string;
    mac: string;
    domain: string;
    dhcp: {
      enabled: boolean;
      leaseTime: string;
      authoritative?: boolean;
    };
  }>;
  external?: {
    multusNetwork: string;
    primaryCidr?: string;
    gateway?: string;
    mac?: string;
    snat?: boolean;
  } | null;
  leases: Array<{
    vpc: string;
    mac: string;
    ip: string;
    hostname: string;
    vm?: string;
  }>;
  floatingIPs: Array<{
    id: string;
    public: string;
    prefix: number;
    private?: string;
    targetVm?: string;
    vpc?: string;
    protocol?: string;
  }>;
};

/**
 * @kubernetes/client-node may surface HTTP status on several shapes
 * (`statusCode`, nested `response`, or only in the message as `HTTP-Code: 409`).
 */
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
  const jsonCode = msg.match(/"code"\s*:\s*(\d{3})/);
  if (jsonCode) {
    const parsed = Number(jsonCode[1]);
    if (Number.isFinite(parsed)) return parsed;
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
  // Create races report 409 AlreadyExists; optimistic-lock Conflicts also use 409.
  if (apiStatusCode(err) === 409) {
    return !isOptimisticLockConflict(err);
  }
  return false;
}

/**
 * ConfigMap replace lost a race with another writer (router agent heartbeat,
 * concurrent lease/FIP updates during multi-VM launch).
 */
function isOptimisticLockConflict(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  if (
    message.includes("the object has been modified") ||
    message.includes("please apply your changes to the latest version")
  ) {
    return true;
  }
  if (apiStatusCode(err) === 409) {
    if (message.includes("already exists") || message.includes("alreadyexists")) {
      return false;
    }
    return message.includes("conflict") || message.includes("modified");
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const POLICY_MUTATE_MAX_ATTEMPTS = 12;

/**
 * Read → mutate → replace a router policy ConfigMap, retrying on optimistic
 * lock conflicts so multi-VM launch and agent heartbeats can coexist.
 *
 * Uses a single GET for both the policy document and resourceVersion so a
 * concurrent writer always surfaces as 409 (then we re-read and re-merge)
 * instead of a silent overwrite.
 *
 * `mutate` may return `false` to skip the write (no-op). Throws if the policy
 * CM is missing.
 */
async function mutateRouterPolicyDoc(
  cluster: ClusterId,
  namespace: string,
  routerName: string,
  mutate: (doc: RouterPolicyDoc) => void | boolean,
  opts?: { bumpGeneration?: boolean; maxAttempts?: number },
): Promise<RouterPolicyDoc> {
  const maxAttempts = opts?.maxAttempts ?? POLICY_MUTATE_MAX_ATTEMPTS;
  const bumpGeneration = opts?.bumpGeneration ?? true;
  const name = routerPolicyConfigMapName(routerName);
  const { core } = getClusterClients(cluster);
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      let existing: Awaited<ReturnType<typeof core.readNamespacedConfigMap>>;
      try {
        existing = await core.readNamespacedConfigMap({ name, namespace });
      } catch (err) {
        if (isNotFound(err)) {
          throw new Error(
            `Router policy not found for ${namespace}/${routerName}`,
          );
        }
        throw err;
      }

      const doc = parseRouterPolicyDoc(
        existing.data?.[KMC_ROUTER_POLICY_DATA_KEY],
      );
      if (!doc) {
        throw new Error(
          `Router policy not found for ${namespace}/${routerName}`,
        );
      }

      const result = mutate(doc);
      if (result === false) return doc;

      const next: RouterPolicyDoc = {
        ...doc,
        metadata: {
          name: routerName,
          namespace,
          generation: bumpGeneration
            ? (doc.metadata?.generation || 0) + 1
            : doc.metadata?.generation || 1,
        },
      };
      const { ownerReferences: _drop, ...metaRest } = existing.metadata ?? {};
      void _drop;
      await core.replaceNamespacedConfigMap({
        name,
        namespace,
        body: {
          ...existing,
          metadata: {
            ...metaRest,
            name,
            namespace,
            // Keep resourceVersion from this read for optimistic concurrency.
            resourceVersion: existing.metadata?.resourceVersion,
            labels: {
              ...(existing.metadata?.labels ?? {}),
              [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
              [KMC_LABEL_RESOURCE]: KMC_RESOURCE_ROUTER_POLICY,
              [KMC_LABEL_ROUTER]: routerName,
              [KMC_LABEL_ROLE]: KMC_ROLE_ROUTER,
            },
            ownerReferences: [],
          },
          data: {
            ...(existing.data ?? {}),
            [KMC_ROUTER_POLICY_DATA_KEY]: JSON.stringify(next, null, 2),
            [KMC_ROUTER_AGENT_SCRIPT_KEY]: normalizeAgentScript(
              existing.data?.[KMC_ROUTER_AGENT_SCRIPT_KEY],
            ),
          },
        },
      });
      return next;
    } catch (err) {
      lastErr = err;
      if (!isOptimisticLockConflict(err) || attempt === maxAttempts - 1) {
        if (err instanceof Error) throw err;
        throw new Error(formatError(err), { cause: err });
      }
      // Brief jittered backoff; conflicts are usually resolved on the next try.
      const delay = 20 + Math.floor(Math.random() * 40) + attempt * 30;
      await sleep(delay);
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(formatError(lastErr), { cause: lastErr });
}

export function routerPolicyConfigMapName(routerName: string): string {
  return `kmc-router-${routerName}`.slice(0, 63);
}

export function routerAgentServiceAccountName(routerName: string): string {
  return `kmc-router-${routerName}`.slice(0, 63);
}

export function routerAgentRoleName(routerName: string): string {
  return `kmc-router-${routerName}`.slice(0, 63);
}

export function defaultRouterDomain(vpcName: string): string {
  const base = vpcName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || "vpc"}.vpc.local`;
}

function normalizeAgentScript(script?: string): string {
  const raw = script ?? getRouterAgentScript();
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

export function emptyRouterPolicyDoc(
  routerName: string,
  namespace: string,
): RouterPolicyDoc {
  return {
    apiVersion: "kmc.ianunruh.com/v1alpha1",
    kind: "RouterPolicy",
    metadata: { name: routerName, namespace, generation: 1 },
    interfaces: [],
    external: null,
    leases: [],
    floatingIPs: [],
  };
}

export function parseRouterPolicyDoc(raw: string | undefined): RouterPolicyDoc | null {
  if (!raw?.trim()) return null;
  try {
    const doc = JSON.parse(raw) as RouterPolicyDoc;
    if (doc?.kind !== "RouterPolicy") return null;
    if (!doc.metadata) {
      doc.metadata = { name: "", namespace: "", generation: 1 };
    }
    doc.interfaces = Array.isArray(doc.interfaces) ? doc.interfaces : [];
    doc.leases = Array.isArray(doc.leases) ? doc.leases : [];
    doc.floatingIPs = Array.isArray(doc.floatingIPs) ? doc.floatingIPs : [];
    return doc;
  } catch {
    return null;
  }
}

function deriveAgentStatus(
  annotations: Record<string, string>,
  nowMs: number = Date.now(),
): RouterAgentStatus {
  const raw = annotations[KMC_ANN_AGENT_STATUS]?.trim();
  let status: RouterAgentStatus =
    raw === "Ready" ||
    raw === "Error" ||
    raw === "Pending" ||
    raw === "Unknown" ||
    raw === "Stale"
      ? raw
      : raw
        ? "Unknown"
        : "Pending";

  if (status === "Ready" || status === "Pending") {
    const hb = annotations[KMC_ANN_AGENT_HEARTBEAT_AT]?.trim();
    if (hb) {
      const t = Date.parse(hb);
      if (!Number.isNaN(t) && nowMs - t > KMC_AGENT_STALE_AFTER_MS) {
        status = "Stale";
      }
    } else if (status === "Ready") {
      status = "Stale";
    }
  }
  return status;
}

export function agentInfoFromRouterAnnotations(
  annotations: Record<string, string>,
  nowMs: number = Date.now(),
): Pick<
  RouterDetail,
  | "agentStatus"
  | "agentObservedGeneration"
  | "agentLastError"
  | "agentAppliedAt"
  | "agentHeartbeatAt"
  | "agentVersion"
> {
  return {
    agentStatus: deriveAgentStatus(annotations, nowMs),
    agentObservedGeneration:
      annotations[KMC_ANN_AGENT_OBSERVED_GENERATION]?.trim() || undefined,
    agentLastError: annotations[KMC_ANN_AGENT_LAST_ERROR]?.trim() || undefined,
    agentAppliedAt: annotations[KMC_ANN_AGENT_APPLIED_AT]?.trim() || undefined,
    agentHeartbeatAt: annotations[KMC_ANN_AGENT_HEARTBEAT_AT]?.trim() || undefined,
    agentVersion: annotations[KMC_ANN_AGENT_VERSION]?.trim() || undefined,
  };
}

export async function getRouterPolicyConfigMap(
  cluster: ClusterId,
  namespace: string,
  routerName: string,
): Promise<{
  name: string;
  doc: RouterPolicyDoc | null;
  annotations: Record<string, string>;
  resourceVersion?: string;
  creationTimestamp?: string;
  labels: Record<string, string>;
} | null> {
  const name = routerPolicyConfigMapName(routerName);
  const { core } = getClusterClients(cluster);
  try {
    const cm = await core.readNamespacedConfigMap({ name, namespace });
    const raw = cm.data?.[KMC_ROUTER_POLICY_DATA_KEY];
    const created = cm.metadata?.creationTimestamp;
    return {
      name,
      doc: parseRouterPolicyDoc(raw),
      annotations: cm.metadata?.annotations ?? {},
      resourceVersion: cm.metadata?.resourceVersion,
      creationTimestamp:
        created instanceof Date
          ? created.toISOString()
          : created != null
            ? String(created)
            : undefined,
      labels: cm.metadata?.labels ?? {},
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new Error(formatError(err), { cause: err });
  }
}

export function summaryFromRouterPolicy(
  cluster: ClusterId,
  namespace: string,
  routerName: string,
  doc: RouterPolicyDoc | null,
  annotations: Record<string, string>,
  creationTimestamp?: string,
): RouterSummary {
  const agent = agentInfoFromRouterAnnotations(annotations);
  return {
    cluster,
    namespace,
    name: routerName,
    vpcNames: (doc?.interfaces ?? []).map((i) => i.vpc).filter(Boolean),
    hasExternal: Boolean(doc?.external?.multusNetwork?.trim()),
    agentStatus: agent.agentStatus,
    agentHeartbeatAt: agent.agentHeartbeatAt,
    age: creationTimestamp ? formatAge(creationTimestamp) : "—",
  };
}

export function interfacesFromDoc(doc: RouterPolicyDoc | null): RouterInterfaceInfo[] {
  if (!doc) return [];
  const leaseCountByVpc = new Map<string, number>();
  for (const L of doc.leases) {
    const v = L.vpc?.trim();
    if (!v) continue;
    leaseCountByVpc.set(v, (leaseCountByVpc.get(v) ?? 0) + 1);
  }
  return doc.interfaces.map((i) => ({
    vpc: i.vpc,
    cidr: i.cidr,
    gateway: i.gateway,
    mac: i.mac,
    domain: i.domain,
    dhcpEnabled: i.dhcp?.enabled !== false,
    leaseCount: leaseCountByVpc.get(i.vpc) ?? 0,
  }));
}

export function leasesFromDoc(doc: RouterPolicyDoc | null): RouterLease[] {
  if (!doc) return [];
  return doc.leases.map((L) => ({
    vpc: L.vpc,
    mac: L.mac,
    ip: L.ip,
    hostname: L.hostname,
    vm: L.vm,
  }));
}

export function floatingIpsFromRouterDoc(
  doc: RouterPolicyDoc | null,
): FloatingIpAssociation[] {
  if (!doc) return [];
  return (doc.floatingIPs ?? []).map((f) => ({
    id: f.id,
    public: f.public,
    prefix: f.prefix,
    private: f.private,
    targetVm: f.targetVm,
    state: f.private?.trim() ? ("associated" as const) : ("held" as const),
  }));
}

/**
 * Create SA + Role + RoleBinding + token + policy CM for a shared router.
 */
export async function ensureRouterControlPlane(input: {
  cluster: ClusterId;
  namespace: string;
  routerName: string;
  doc: RouterPolicyDoc;
}): Promise<{
  policyConfigMap: string;
  serviceAccount: string;
  token: string;
  caData: string;
  apiServer: string;
  network: ClusterNetworkConfig;
  podCIDRs: string[];
  serviceCIDRs: string[];
}> {
  const identity = requireClusterIdentity(input.cluster);
  const network = getClusterNetwork(input.cluster);
  if (!network) {
    throw new Error(
      `Cluster "${input.cluster}" has no network.podCIDR/serviceCIDR in clusters.yaml — required for router pod NIC + agent`,
    );
  }
  const { podCIDRs, serviceCIDRs } = clusterNetworkCidrList(network);

  let caData = identity.caData?.trim();
  if (!caData && identity.caFile) {
    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const path = resolve(identity.caFile);
    if (existsSync(path)) {
      caData = readFileSync(path, "utf8").trim();
      if (caData.includes("BEGIN CERTIFICATE")) {
        caData = Buffer.from(caData, "utf8").toString("base64");
      }
    }
  }
  if (!caData) {
    throw new Error(
      `Cluster "${input.cluster}" has no caData/caFile — required for router agent kubeconfig`,
    );
  }

  const { core, rbac } = getClusterClients(input.cluster);
  const ns = input.namespace;
  const routerName = input.routerName;
  const cmName = routerPolicyConfigMapName(routerName);
  const saName = routerAgentServiceAccountName(routerName);
  const roleName = routerAgentRoleName(routerName);
  const labels = {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_ROUTER_POLICY,
    [KMC_LABEL_ROUTER]: routerName,
    [KMC_LABEL_ROLE]: KMC_ROLE_ROUTER,
  };

  try {
    await core.createNamespacedServiceAccount({
      namespace: ns,
      body: {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: { name: saName, namespace: ns, labels },
      },
    });
  } catch (err) {
    if (!isAlreadyExists(err)) {
      throw new Error(
        `Failed to create ServiceAccount ${ns}/${saName}: ${formatError(err)}`,
        { cause: err },
      );
    }
  }

  const roleBody = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: { name: roleName, namespace: ns, labels },
    rules: [
      {
        apiGroups: [""],
        resources: ["configmaps"],
        resourceNames: [cmName],
        verbs: ["get", "update", "patch"],
      },
      {
        apiGroups: [""],
        resources: ["configmaps"],
        verbs: ["list", "watch"],
      },
    ],
  };
  try {
    await rbac.createNamespacedRole({ namespace: ns, body: roleBody });
  } catch (err) {
    if (isAlreadyExists(err)) {
      await rbac.replaceNamespacedRole({
        name: roleName,
        namespace: ns,
        body: roleBody,
      });
    } else {
      throw new Error(`Failed to create Role ${ns}/${roleName}: ${formatError(err)}`, {
        cause: err,
      });
    }
  }

  try {
    await rbac.createNamespacedRoleBinding({
      namespace: ns,
      body: {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name: roleName, namespace: ns, labels },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "Role",
          name: roleName,
        },
        subjects: [{ kind: "ServiceAccount", name: saName, namespace: ns }],
      },
    });
  } catch (err) {
    if (!isAlreadyExists(err)) {
      throw new Error(
        `Failed to create RoleBinding ${ns}/${roleName}: ${formatError(err)}`,
        { cause: err },
      );
    }
  }

  let token: string;
  try {
    const tr = await core.createNamespacedServiceAccountToken({
      name: saName,
      namespace: ns,
      body: {
        apiVersion: "authentication.k8s.io/v1",
        kind: "TokenRequest",
        spec: {
          audiences: [identity.apiServer.replace(/\/$/, "")],
          expirationSeconds: 60 * 60 * 24 * 365,
        },
      },
    });
    token = tr.status?.token?.trim() ?? "";
    if (!token) throw new Error("TokenRequest returned empty token");
  } catch (err) {
    throw new Error(
      `Failed to mint ServiceAccount token for ${ns}/${saName}: ${formatError(err)}`,
      { cause: err },
    );
  }

  const agentScript = normalizeAgentScript();
  const doc: RouterPolicyDoc = {
    ...input.doc,
    metadata: {
      name: routerName,
      namespace: ns,
      generation: input.doc.metadata?.generation || 1,
    },
  };

  // Upsert policy CM: read first so we never replace a missing object after a
  // misclassified create error (client-node status codes are inconsistent).
  let existingCm: Awaited<
    ReturnType<typeof core.readNamespacedConfigMap>
  > | null = null;
  try {
    existingCm = await core.readNamespacedConfigMap({ name: cmName, namespace: ns });
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(
        `Failed to read policy ConfigMap ${ns}/${cmName}: ${formatError(err)}`,
        { cause: err },
      );
    }
  }

  if (existingCm) {
    await replaceRouterPolicyDoc(input.cluster, ns, routerName, doc, {
      bumpGeneration: true,
    });
  } else {
    try {
      await core.createNamespacedConfigMap({
        namespace: ns,
        body: {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name: cmName,
            namespace: ns,
            labels,
            annotations: {
              [KMC_ANN_AGENT_STATUS]: "Pending",
            },
          },
          data: {
            [KMC_ROUTER_POLICY_DATA_KEY]: JSON.stringify(doc, null, 2),
            [KMC_ROUTER_AGENT_SCRIPT_KEY]: agentScript,
          },
        },
      });
    } catch (err) {
      if (isAlreadyExists(err)) {
        // Race: another request created it; replace with our desired doc.
        await replaceRouterPolicyDoc(input.cluster, ns, routerName, doc, {
          bumpGeneration: true,
        });
      } else {
        throw new Error(
          `Failed to create policy ConfigMap ${ns}/${cmName}: ${formatError(err)}`,
          { cause: err },
        );
      }
    }
  }

  return {
    policyConfigMap: cmName,
    serviceAccount: saName,
    token,
    caData,
    apiServer: identity.apiServer.replace(/\/$/, ""),
    network,
    podCIDRs,
    serviceCIDRs,
  };
}

export async function replaceRouterPolicyDoc(
  cluster: ClusterId,
  namespace: string,
  routerName: string,
  doc: RouterPolicyDoc,
  opts?: { bumpGeneration?: boolean },
): Promise<RouterPolicyDoc> {
  const name = routerPolicyConfigMapName(routerName);
  const { core } = getClusterClients(cluster);
  let existing: Awaited<ReturnType<typeof core.readNamespacedConfigMap>>;
  try {
    existing = await core.readNamespacedConfigMap({ name, namespace });
  } catch (err) {
    if (isNotFound(err)) {
      // Create instead of failing replace on a missing CM.
      const next: RouterPolicyDoc = {
        ...doc,
        metadata: {
          name: routerName,
          namespace,
          generation: doc.metadata?.generation || 1,
        },
      };
      const labels = {
        [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
        [KMC_LABEL_RESOURCE]: KMC_RESOURCE_ROUTER_POLICY,
        [KMC_LABEL_ROUTER]: routerName,
        [KMC_LABEL_ROLE]: KMC_ROLE_ROUTER,
      };
      await core.createNamespacedConfigMap({
        namespace,
        body: {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name,
            namespace,
            labels,
            annotations: {
              [KMC_ANN_AGENT_STATUS]: "Pending",
            },
          },
          data: {
            [KMC_ROUTER_POLICY_DATA_KEY]: JSON.stringify(next, null, 2),
            [KMC_ROUTER_AGENT_SCRIPT_KEY]: normalizeAgentScript(),
          },
        },
      });
      return next;
    }
    throw new Error(
      `Failed to read policy ConfigMap ${namespace}/${name}: ${formatError(err)}`,
      { cause: err },
    );
  }
  const next: RouterPolicyDoc = {
    ...doc,
    metadata: {
      name: routerName,
      namespace,
      generation: opts?.bumpGeneration
        ? (doc.metadata?.generation || 0) + 1
        : doc.metadata?.generation || 1,
    },
  };
  const { ownerReferences: _drop, ...metaRest } = existing.metadata ?? {};
  void _drop;
  await core.replaceNamespacedConfigMap({
    name,
    namespace,
    body: {
      ...existing,
      metadata: {
        ...metaRest,
        name,
        namespace,
        labels: {
          ...(existing.metadata?.labels ?? {}),
          [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
          [KMC_LABEL_RESOURCE]: KMC_RESOURCE_ROUTER_POLICY,
          [KMC_LABEL_ROUTER]: routerName,
          [KMC_LABEL_ROLE]: KMC_ROLE_ROUTER,
        },
        ownerReferences: [],
      },
      data: {
        ...(existing.data ?? {}),
        [KMC_ROUTER_POLICY_DATA_KEY]: JSON.stringify(next, null, 2),
        [KMC_ROUTER_AGENT_SCRIPT_KEY]: normalizeAgentScript(),
      },
    },
  });
  return next;
}

export async function syncRouterAgentScript(
  cluster: ClusterId,
  namespace: string,
  routerName: string,
): Promise<boolean> {
  const name = routerPolicyConfigMapName(routerName);
  const { core } = getClusterClients(cluster);
  const agentScript = normalizeAgentScript();
  try {
    const existing = await core.readNamespacedConfigMap({ name, namespace });
    const current = existing.data?.[KMC_ROUTER_AGENT_SCRIPT_KEY] ?? "";
    if (normalizeAgentScript(current) === agentScript) return false;
    const { ownerReferences: _drop, ...metaRest } = existing.metadata ?? {};
    void _drop;
    await core.replaceNamespacedConfigMap({
      name,
      namespace,
      body: {
        ...existing,
        metadata: {
          ...metaRest,
          name,
          namespace,
          ownerReferences: [],
        },
        data: {
          ...(existing.data ?? {}),
          [KMC_ROUTER_AGENT_SCRIPT_KEY]: agentScript,
        },
      },
    });
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw new Error(
      `Failed to sync router agent script on ${namespace}/${name}: ${formatError(err)}`,
      { cause: err },
    );
  }
}

export async function upsertRouterLease(
  cluster: ClusterId,
  namespace: string,
  routerName: string,
  lease: RouterLease,
): Promise<void> {
  const mac = lease.mac.trim().toLowerCase();
  const ip = lease.ip.trim();
  const vpc = lease.vpc.trim();
  await mutateRouterPolicyDoc(cluster, namespace, routerName, (doc) => {
    const filtered = doc.leases.filter(
      (L) =>
        !(
          L.vpc === vpc &&
          (L.mac.toLowerCase() === mac ||
            L.ip === ip ||
            (lease.vm && L.vm === lease.vm))
        ),
    );
    filtered.push({
      vpc,
      mac,
      ip,
      hostname: lease.hostname.trim() || lease.vm || "host",
      ...(lease.vm ? { vm: lease.vm } : {}),
    });
    doc.leases = filtered;
  });
}

/**
 * On VM delete (or failed create): drop DHCP leases for the guest and
 * disassociate any floating IPs that targeted it. Public addresses are retained
 * as **held** (same as manual disassociate) so they stay reserved for the VPC.
 */
export async function removeRouterLeasesForVm(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<void> {
  const { core } = getClusterClients(cluster);
  let items: Array<{
    metadata?: { name?: string; labels?: Record<string, string> };
    data?: Record<string, string>;
  }> = [];
  try {
    const res = await core.listNamespacedConfigMap({
      namespace,
      labelSelector: KMC_ROUTER_POLICY_LABEL_SELECTOR,
    });
    items = res.items ?? [];
  } catch (err) {
    console.error("removeRouterLeasesForVm list failed:", formatError(err));
    return;
  }

  for (const cm of items) {
    const labels = cm.metadata?.labels;
    const nameFromLabel = labels?.[KMC_LABEL_ROUTER]?.trim();
    const routerName =
      nameFromLabel ||
      cm.metadata?.name?.replace(/^kmc-router-/, "") ||
      cm.metadata?.name ||
      "";
    if (!routerName) continue;
    const preview = parseRouterPolicyDoc(cm.data?.[KMC_ROUTER_POLICY_DATA_KEY]);
    if (!preview) continue;
    const hasLease = preview.leases.some((L) => L.vm === vmName);
    const hasFloat = (preview.floatingIPs ?? []).some(
      (f) => f.targetVm === vmName && Boolean(f.private?.trim()),
    );
    if (!hasLease && !hasFloat) continue;
    try {
      let disassociatedFloats = false;
      const next = await mutateRouterPolicyDoc(
        cluster,
        namespace,
        routerName,
        (doc) => {
          const vmLeaseIps = new Set(
            doc.leases
              .filter((L) => L.vm === vmName)
              .map((L) => addressFromIpv4Annotation(L.ip) ?? L.ip.trim())
              .filter(Boolean),
          );
          const leaseBefore = doc.leases.length;
          doc.leases = doc.leases.filter((L) => L.vm !== vmName);
          const leaseChanged = doc.leases.length !== leaseBefore;

          let fipChanged = false;
          doc.floatingIPs = (doc.floatingIPs ?? []).map((f) => {
            const privRaw = f.private?.trim();
            if (!privRaw) return f;
            const priv = addressFromIpv4Annotation(privRaw) ?? privRaw;
            const matchesVm =
              f.targetVm === vmName || (priv ? vmLeaseIps.has(priv) : false);
            if (!matchesVm) return f;
            fipChanged = true;
            // Hold: keep public reservation; clear private mapping (like disassociate).
            return {
              id: f.id,
              public: f.public,
              prefix: f.prefix,
              protocol: f.protocol ?? "all",
              vpc: f.vpc,
            };
          });

          if (fipChanged) disassociatedFloats = true;
          if (!leaseChanged && !fipChanged) return false;
        },
      );
      // Secondary IPs on the router NIC stay (held floats); annotation lists all.
      if (disassociatedFloats) {
        await syncRouterFloatingAnnotation(
          cluster,
          namespace,
          routerName,
          floatingIpsFromRouterDoc(next),
        );
      }
    } catch (err) {
      console.error(
        `removeRouterLeasesForVm ${namespace}/${cm.metadata?.name}:`,
        formatError(err),
      );
    }
  }
}

/** Best-effort cleanup of router control-plane objects. */
export async function deleteRouterControlPlane(
  cluster: ClusterId,
  namespace: string,
  routerName: string,
): Promise<void> {
  const { core, rbac } = getClusterClients(cluster);
  const cmName = routerPolicyConfigMapName(routerName);
  const saName = routerAgentServiceAccountName(routerName);
  const roleName = routerAgentRoleName(routerName);

  const ignore = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      if (!isNotFound(err)) {
        console.error("deleteRouterControlPlane:", formatError(err));
      }
    }
  };

  await ignore(() => core.deleteNamespacedConfigMap({ name: cmName, namespace }));
  await ignore(() =>
    rbac.deleteNamespacedRoleBinding({ name: roleName, namespace }),
  );
  await ignore(() => rbac.deleteNamespacedRole({ name: roleName, namespace }));
  await ignore(() =>
    core.deleteNamespacedServiceAccount({ name: saName, namespace }),
  );
}

export async function listRouterPolicyConfigMaps(cluster: ClusterId): Promise<
  Array<{
    namespace: string;
    routerName: string;
    doc: RouterPolicyDoc | null;
    annotations: Record<string, string>;
    creationTimestamp?: string;
  }>
> {
  const { core } = getClusterClients(cluster);
  const out: Array<{
    namespace: string;
    routerName: string;
    doc: RouterPolicyDoc | null;
    annotations: Record<string, string>;
    creationTimestamp?: string;
  }> = [];
  try {
    const res = await core.listConfigMapForAllNamespaces({
      labelSelector: KMC_ROUTER_POLICY_LABEL_SELECTOR,
    });
    for (const cm of res.items ?? []) {
      const ns = cm.metadata?.namespace ?? "";
      const routerName =
        cm.metadata?.labels?.[KMC_LABEL_ROUTER]?.trim() ||
        (cm.metadata?.name ?? "").replace(/^kmc-router-/, "");
      if (!ns || !routerName) continue;
      const created = cm.metadata?.creationTimestamp;
      out.push({
        namespace: ns,
        routerName,
        doc: parseRouterPolicyDoc(cm.data?.[KMC_ROUTER_POLICY_DATA_KEY]),
        annotations: cm.metadata?.annotations ?? {},
        creationTimestamp:
          created instanceof Date
            ? created.toISOString()
            : created != null
              ? String(created)
              : undefined,
      });
    }
  } catch (err) {
    console.error("listRouterPolicyConfigMaps failed:", formatError(err));
  }
  return out;
}

/**
 * Find router name that has an interface on this VPC (from policy CMs in namespace).
 */
export async function findRouterNameForVpc(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
): Promise<string | undefined> {
  const { core } = getClusterClients(cluster);
  try {
    const res = await core.listNamespacedConfigMap({
      namespace,
      labelSelector: KMC_ROUTER_POLICY_LABEL_SELECTOR,
    });
    for (const cm of res.items ?? []) {
      const doc = parseRouterPolicyDoc(cm.data?.[KMC_ROUTER_POLICY_DATA_KEY]);
      if (!doc) continue;
      if (doc.interfaces.some((i) => i.vpc === vpcName)) {
        return (
          cm.metadata?.labels?.[KMC_LABEL_ROUTER]?.trim() ||
          doc.metadata?.name ||
          undefined
        );
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function findRouterFloatEntry(
  doc: RouterPolicyDoc,
  idOrPublic: string,
): { index: number; entry: RouterPolicyDoc["floatingIPs"][number] } | null {
  const key = idOrPublic.trim();
  if (!key) return null;
  const index = doc.floatingIPs.findIndex((f) => {
    const pub = addressFromIpv4Annotation(f.public) ?? f.public;
    return f.id === key || pub === key;
  });
  if (index < 0) return null;
  return { index, entry: doc.floatingIPs[index]! };
}

async function resolvePrivateOnVpc(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
  vpcCidr: string,
  opts: { privateIpv4?: string; targetVm?: string },
): Promise<{ privateIpv4: string; targetVm?: string }> {
  if (opts.privateIpv4?.trim()) {
    const addr =
      addressFromIpv4Annotation(opts.privateIpv4.trim()) ?? opts.privateIpv4.trim();
    if (!containsIpv4(parseCidr(vpcCidr), addr)) {
      throw new Error(`Private address ${addr} is outside VPC CIDR ${vpcCidr}`);
    }
    return { privateIpv4: addr, targetVm: opts.targetVm?.trim() || undefined };
  }
  const vmName = opts.targetVm?.trim();
  if (!vmName) throw new Error("privateIpv4 or targetVm is required");
  const { custom } = getClusterClients(cluster);
  const vm = (await custom.getNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace,
    plural: "virtualmachines",
    name: vmName,
  })) as { metadata?: { annotations?: Record<string, string> } };
  const ann = vm.metadata?.annotations?.[IPAM_ANNOTATION_IPV4];
  const parts = ann ? parseIpv4AnnotationList(ann) : [];
  const parsed = parseCidr(vpcCidr);
  const match = parts.find((a) => containsIpv4(parsed, a));
  if (!match) {
    throw new Error(
      `VM ${namespace}/${vmName} has no IPAM address in VPC CIDR ${vpcCidr}`,
    );
  }
  return { privateIpv4: match, targetVm: vmName };
}

async function syncRouterFloatingAnnotation(
  cluster: ClusterId,
  namespace: string,
  routerVm: string,
  floats: FloatingIpAssociation[],
): Promise<void> {
  const { custom } = getClusterClients(cluster);
  try {
    const vm = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name: routerVm,
    })) as {
      metadata?: { annotations?: Record<string, string>; [k: string]: unknown };
      [k: string]: unknown;
    };
    const annotations = { ...(vm.metadata?.annotations ?? {}) };
    if (floats.length === 0) {
      delete annotations[KMC_ANN_FLOATING_IPV4];
    } else {
      annotations[KMC_ANN_FLOATING_IPV4] = floats
        .map((f) => `${f.public}/${f.prefix}`)
        .join(",");
    }
    await custom.replaceNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name: routerVm,
      body: {
        ...vm,
        metadata: {
          ...(vm.metadata as object),
          annotations,
        },
      },
    });
  } catch (err) {
    console.error("syncRouterFloatingAnnotation:", formatError(err));
  }
}

/**
 * Associate a floating IP via a router policy (requires external gateway).
 */
export async function associateRouterFloatingIp(
  input: AssociateFloatingIpRequest & {
    routerName: string;
    vpcCidr: string;
    publicMultusNetwork: string;
  },
): Promise<FloatingIpAssociation> {
  const policy = await getRouterPolicyConfigMap(
    input.cluster,
    input.namespace,
    input.routerName,
  );
  if (!policy?.doc) {
    throw new Error(
      `No router policy for ${input.namespace}/${input.routerName}`,
    );
  }
  const doc = policy.doc;
  if (!doc.external?.multusNetwork?.trim()) {
    throw new Error(
      `Router ${input.routerName} has no external gateway — set one before floating IPs`,
    );
  }
  if (!doc.interfaces.some((i) => i.vpc === input.vpcName)) {
    throw new Error(
      `VPC ${input.vpcName} is not attached to router ${input.routerName}`,
    );
  }

  const { privateIpv4, targetVm } = await resolvePrivateOnVpc(
    input.cluster,
    input.namespace,
    input.vpcName,
    input.vpcCidr,
    { privateIpv4: input.privateIpv4, targetVm: input.targetVm },
  );

  const existingPrivate = doc.floatingIPs.find((f) => {
    const priv = f.private?.trim();
    if (!priv) return false;
    return (addressFromIpv4Annotation(priv) ?? priv) === privateIpv4;
  });
  if (existingPrivate) {
    throw new Error(
      `Private address ${privateIpv4} already has floating IP ${existingPrivate.public}`,
    );
  }

  const publicPool = findIpPoolForMultus(input.cluster, input.publicMultusNetwork);
  if (!publicPool) {
    throw new Error(`No ipPools entry for public Multus "${input.publicMultusNetwork}"`);
  }
  const prefix = parseCidr(publicPool.cidr).prefix;

  if (input.publicIpv4?.trim()) {
    const wanted =
      addressFromIpv4Annotation(input.publicIpv4.trim()) ?? input.publicIpv4.trim();
    const heldIdx = doc.floatingIPs.findIndex((f) => {
      const pub = addressFromIpv4Annotation(f.public) ?? f.public;
      return pub === wanted && !f.private?.trim();
    });
    if (heldIdx >= 0) {
      const held = doc.floatingIPs[heldIdx]!;
      doc.floatingIPs[heldIdx] = {
        ...held,
        private: privateIpv4,
        targetVm,
        vpc: input.vpcName,
        protocol: held.protocol ?? "all",
      };
      await replaceRouterPolicyDoc(
        input.cluster,
        input.namespace,
        input.routerName,
        doc,
        { bumpGeneration: true },
      );
      await syncRouterFloatingAnnotation(
        input.cluster,
        input.namespace,
        input.routerName,
        floatingIpsFromRouterDoc(doc),
      );
      return {
        id: held.id,
        public: addressFromIpv4Annotation(held.public) ?? held.public,
        prefix: held.prefix || prefix,
        private: privateIpv4,
        targetVm,
        state: "associated",
      };
    }
    const already = doc.floatingIPs.find((f) => {
      const pub = addressFromIpv4Annotation(f.public) ?? f.public;
      return pub === wanted && Boolean(f.private?.trim());
    });
    if (already) {
      throw new Error(
        `Public address ${wanted} is already associated to ${already.private}`,
      );
    }
  }

  let publicAddr: string;
  if (input.publicIpv4?.trim()) {
    publicAddr =
      addressFromIpv4Annotation(input.publicIpv4.trim()) ?? input.publicIpv4.trim();
    if (!containsIpv4(parseCidr(publicPool.cidr), publicAddr)) {
      throw new Error(`Public address ${publicAddr} is outside pool ${publicPool.cidr}`);
    }
    await allocateIpv4ForMultus(
      input.cluster,
      input.publicMultusNetwork,
      input.namespace,
      { preferredAddress: publicAddr },
    );
  } else {
    const alloc = await allocateIpv4ForMultus(
      input.cluster,
      input.publicMultusNetwork,
      input.namespace,
    );
    if (!alloc) throw new Error("Could not allocate a public floating IP");
    publicAddr = alloc.address;
  }

  if (
    doc.floatingIPs.some(
      (f) => (addressFromIpv4Annotation(f.public) ?? f.public) === publicAddr,
    )
  ) {
    throw new Error(`Public address ${publicAddr} is already a floating IP`);
  }

  const id = `fip-${publicAddr.replace(/\./g, "-")}`;
  doc.floatingIPs = [
    ...doc.floatingIPs,
    {
      id,
      public: publicAddr,
      prefix,
      private: privateIpv4,
      targetVm,
      vpc: input.vpcName,
      protocol: "all",
    },
  ];
  await replaceRouterPolicyDoc(
    input.cluster,
    input.namespace,
    input.routerName,
    doc,
    { bumpGeneration: true },
  );
  await syncRouterFloatingAnnotation(
    input.cluster,
    input.namespace,
    input.routerName,
    floatingIpsFromRouterDoc(doc),
  );
  return {
    id,
    public: publicAddr,
    prefix,
    private: privateIpv4,
    targetVm,
    state: "associated",
  };
}

export async function disassociateRouterFloatingIp(
  input: DisassociateFloatingIpRequest & { routerName: string },
): Promise<void> {
  const policy = await getRouterPolicyConfigMap(
    input.cluster,
    input.namespace,
    input.routerName,
  );
  if (!policy?.doc) {
    throw new Error(`No router policy for ${input.namespace}/${input.routerName}`);
  }
  const found = findRouterFloatEntry(policy.doc, input.idOrPublic);
  if (!found) {
    throw new Error(`Floating IP "${input.idOrPublic.trim()}" not found on this router`);
  }
  if (!found.entry.private?.trim()) {
    throw new Error(
      `Floating IP ${found.entry.public} is already held. Release it to free the pool.`,
    );
  }
  policy.doc.floatingIPs[found.index] = {
    id: found.entry.id,
    public: found.entry.public,
    prefix: found.entry.prefix,
    protocol: found.entry.protocol ?? "all",
    vpc: found.entry.vpc,
  };
  await replaceRouterPolicyDoc(
    input.cluster,
    input.namespace,
    input.routerName,
    policy.doc,
    { bumpGeneration: true },
  );
  await syncRouterFloatingAnnotation(
    input.cluster,
    input.namespace,
    input.routerName,
    floatingIpsFromRouterDoc(policy.doc),
  );
}

export async function releaseRouterFloatingIp(
  input: ReleaseFloatingIpRequest & { routerName: string },
): Promise<void> {
  const policy = await getRouterPolicyConfigMap(
    input.cluster,
    input.namespace,
    input.routerName,
  );
  if (!policy?.doc) {
    throw new Error(`No router policy for ${input.namespace}/${input.routerName}`);
  }
  const found = findRouterFloatEntry(policy.doc, input.idOrPublic);
  if (!found) {
    throw new Error(`Floating IP "${input.idOrPublic.trim()}" not found on this router`);
  }
  policy.doc.floatingIPs = policy.doc.floatingIPs.filter((_, i) => i !== found.index);
  await replaceRouterPolicyDoc(
    input.cluster,
    input.namespace,
    input.routerName,
    policy.doc,
    { bumpGeneration: true },
  );
  await syncRouterFloatingAnnotation(
    input.cluster,
    input.namespace,
    input.routerName,
    floatingIpsFromRouterDoc(policy.doc),
  );
}

/** Floating IPs from all router policy ConfigMaps. */
export async function listFloatingIpsFromRouterPolicies(
  cluster: ClusterId,
): Promise<FloatingIpSummary[]> {
  const { core } = getClusterClients(cluster);
  const items: FloatingIpSummary[] = [];
  try {
    const res = await core.listConfigMapForAllNamespaces({
      labelSelector: KMC_ROUTER_POLICY_LABEL_SELECTOR,
    });
    for (const cm of res.items ?? []) {
      const ns = cm.metadata?.namespace ?? "";
      const routerName =
        cm.metadata?.labels?.[KMC_LABEL_ROUTER]?.trim() ||
        (cm.metadata?.name ?? "").replace(/^kmc-router-/, "");
      const doc = parseRouterPolicyDoc(cm.data?.[KMC_ROUTER_POLICY_DATA_KEY]);
      if (!ns || !routerName || !doc) continue;
      const agent = agentInfoFromRouterAnnotations(cm.metadata?.annotations ?? {});
      for (const f of doc.floatingIPs) {
        const privateAddr = f.private?.trim() || undefined;
        const vpcName =
          f.vpc?.trim() ||
          doc.interfaces.find((i) => {
            if (!privateAddr) return false;
            try {
              return containsIpv4(parseCidr(i.cidr), privateAddr);
            } catch {
              return false;
            }
          })?.vpc ||
          doc.interfaces[0]?.vpc ||
          "";
        if (!vpcName) continue;
        items.push({
          cluster,
          namespace: ns,
          vpcName,
          id: f.id,
          public: f.public,
          prefix: f.prefix,
          private: privateAddr,
          targetVm: privateAddr ? f.targetVm : undefined,
          state: privateAddr ? "associated" : "held",
          routerName,
          policyConfigMap: cm.metadata?.name,
          agentStatus: agent.agentStatus,
          agentHeartbeatAt: agent.agentHeartbeatAt,
        });
      }
    }
  } catch (err) {
    console.error(`listFloatingIpsFromRouterPolicies(${cluster}):`, formatError(err));
  }
  return items;
}

/**
 * Floating IPs that target a specific VM (by name or private IPAM address).
 */
export async function listFloatingIpsForVm(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
  privateAddresses: string[] = [],
): Promise<FloatingIpSummary[]> {
  const all = await listFloatingIpsFromRouterPolicies(cluster);
  const privSet = new Set(
    privateAddresses
      .map((a) => addressFromIpv4Annotation(a) ?? a.trim())
      .filter(Boolean),
  );
  return all.filter((f) => {
    if (f.namespace !== namespace) return false;
    if (f.state !== "associated") return false;
    if (f.targetVm && f.targetVm === vmName) return true;
    const priv = f.private
      ? (addressFromIpv4Annotation(f.private) ?? f.private)
      : "";
    return priv ? privSet.has(priv) : false;
  });
}
