import { formatError } from "~/lib/errors";
import type {
  AssociateFloatingIpRequest,
  ClusterId,
  DisassociateFloatingIpRequest,
  FloatingIpAssociation,
  FloatingIpState,
  FloatingIpSummary,
  NatAgentStatus,
  NatGatewayInfo,
  ReleaseFloatingIpRequest,
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
  KMC_LABEL_VPC,
  KMC_MANAGED_BY,
  KMC_NAT_AGENT_SCRIPT_KEY,
  KMC_NAT_AGENT_STALE_AFTER_MS,
  KMC_NAT_POLICY_DATA_KEY,
  KMC_NAT_POLICY_LABEL_SELECTOR,
  KMC_RESOURCE_NAT_POLICY,
  KMC_ROLE_NAT_GATEWAY,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import {
  clusterNetworkCidrList,
  getClusterIdentity,
  getClusterNetwork,
  requireClusterIdentity,
  type ClusterNetworkConfig,
} from "~/lib/k8s/cluster-config.server";
import { getClusterClients } from "~/lib/k8s/clients.server";
import { addressFromIpv4Annotation, containsIpv4, parseCidr } from "~/lib/ipam/cidr";
import { IPAM_ANNOTATION_IPV4 } from "~/lib/ipam/constants";
import {
  allocateIpv4ForMultus,
  findIpPoolForMultus,
  parseIpv4AnnotationList,
} from "~/lib/ipam/pools.server";
import { getNatAgentScript } from "~/vpcs/nat-agent-script";

/** JSON document stored in the policy ConfigMap. */
export type NatGatewayPolicyDoc = {
  apiVersion: "kmc.ianunruh.com/v1alpha1";
  kind: "NatGatewayPolicy";
  metadata: {
    vpc: string;
    generation: number;
  };
  publicInterface?: {
    primaryCidr?: string;
    gateway?: string;
  };
  privateInterface?: {
    cidr?: string;
  };
  floatingIPs: Array<{
    id: string;
    public: string;
    prefix: number;
    /** Private target when associated; empty/omitted when held. */
    private?: string;
    targetVm?: string;
    protocol?: string;
  }>;
};

/** Associated when a private target is set; otherwise held (reserved, unmapped). */
export function floatingIpState(f: {
  private?: string;
}): FloatingIpState {
  return f.private?.trim() ? "associated" : "held";
}

export function natPolicyConfigMapName(vpcName: string): string {
  return `kmc-nat-${vpcName}`.slice(0, 63);
}

export function natAgentServiceAccountName(vpcName: string): string {
  return `kmc-nat-${vpcName}`.slice(0, 63);
}

export function natAgentRoleName(vpcName: string): string {
  return `kmc-nat-${vpcName}`.slice(0, 63);
}

function emptyPolicyDoc(
  vpcName: string,
  opts?: {
    publicPrimaryCidr?: string;
    publicGateway?: string;
    privateCidr?: string;
  },
): NatGatewayPolicyDoc {
  return {
    apiVersion: "kmc.ianunruh.com/v1alpha1",
    kind: "NatGatewayPolicy",
    metadata: { vpc: vpcName, generation: 1 },
    publicInterface: {
      primaryCidr: opts?.publicPrimaryCidr,
      gateway: opts?.publicGateway,
    },
    privateInterface: {
      cidr: opts?.privateCidr,
    },
    floatingIPs: [],
  };
}

export function parsePolicyDoc(raw: string | undefined): NatGatewayPolicyDoc | null {
  if (!raw?.trim()) return null;
  try {
    const doc = JSON.parse(raw) as NatGatewayPolicyDoc;
    if (doc?.kind !== "NatGatewayPolicy") return null;
    if (!Array.isArray(doc.floatingIPs)) doc.floatingIPs = [];
    return doc;
  } catch {
    return null;
  }
}

function mapAgentStatus(raw: string | undefined): NatAgentStatus {
  const v = raw?.trim();
  if (
    v === "Ready" ||
    v === "Error" ||
    v === "Pending" ||
    v === "Unknown" ||
    v === "Stale"
  ) {
    return v;
  }
  return "Unknown";
}

/**
 * Age of the agent heartbeat annotation, or null if missing/unparsable.
 */
export function agentHeartbeatAgeMs(
  annotations: Record<string, string>,
  nowMs: number = Date.now(),
): number | null {
  const raw = annotations[KMC_ANN_AGENT_HEARTBEAT_AT]?.trim() || "";
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return Math.max(0, nowMs - t);
}

/**
 * Derive effective agent status, including Stale when the heartbeat is missing
 * (for Ready) or older than the threshold.
 */
export function deriveAgentStatus(
  annotations: Record<string, string>,
  nowMs: number = Date.now(),
  staleAfterMs: number = KMC_NAT_AGENT_STALE_AFTER_MS,
): NatAgentStatus {
  const base = mapAgentStatus(annotations[KMC_ANN_AGENT_STATUS]);
  if (base === "Error" || base === "Unknown" || base === "Pending") return base;

  const age = agentHeartbeatAgeMs(annotations, nowMs);
  if (age === null || age > staleAfterMs) return "Stale";
  return base;
}

export function floatingIpsFromPolicy(
  doc: NatGatewayPolicyDoc | null,
): FloatingIpAssociation[] {
  if (!doc) return [];
  return doc.floatingIPs.map((f) => {
    const privateAddr = f.private?.trim() || undefined;
    return {
      id: f.id,
      public: f.public,
      prefix: f.prefix,
      private: privateAddr,
      targetVm: privateAddr ? f.targetVm : undefined,
      state: floatingIpState({ private: privateAddr }),
    };
  });
}

/** Normalize agent script for ConfigMap storage (trailing newline). */
export function normalizeAgentScript(script: string = getNatAgentScript()): string {
  const body = script.replace(/\r\n/g, "\n");
  return body.endsWith("\n") ? body : `${body}\n`;
}

/**
 * Read policy ConfigMap for a VPC (same namespace). Returns null if missing.
 */
export async function getNatPolicyConfigMap(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
): Promise<{
  name: string;
  doc: NatGatewayPolicyDoc | null;
  annotations: Record<string, string>;
  resourceVersion?: string;
} | null> {
  const name = natPolicyConfigMapName(vpcName);
  const { core } = getClusterClients(cluster);
  try {
    const cm = await core.readNamespacedConfigMap({ name, namespace });
    const raw = cm.data?.[KMC_NAT_POLICY_DATA_KEY];
    return {
      name,
      doc: parsePolicyDoc(raw),
      annotations: cm.metadata?.annotations ?? {},
      resourceVersion: cm.metadata?.resourceVersion,
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new Error(formatError(err), { cause: err });
  }
}

export function agentInfoFromAnnotations(
  annotations: Record<string, string>,
  nowMs: number = Date.now(),
): Pick<
  NatGatewayInfo,
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

/**
 * Collect floating public IPs from all NAT policy ConfigMaps (IPAM used set).
 */
export async function listFloatingIpv4InUse(cluster: ClusterId): Promise<string[]> {
  const { core } = getClusterClients(cluster);
  const out: string[] = [];
  try {
    const res = await core.listConfigMapForAllNamespaces({
      labelSelector: KMC_NAT_POLICY_LABEL_SELECTOR,
    });
    for (const cm of res.items ?? []) {
      const doc = parsePolicyDoc(cm.data?.[KMC_NAT_POLICY_DATA_KEY]);
      if (!doc) continue;
      for (const f of doc.floatingIPs) {
        const addr = addressFromIpv4Annotation(f.public) ?? f.public.trim();
        if (addr) out.push(addr);
      }
    }
  } catch (err) {
    console.error("listFloatingIpv4InUse failed:", formatError(err));
  }
  return out;
}

/**
 * Create SA + Role + RoleBinding + long-lived token Secret + empty policy CM.
 * Returns names and token material for cloud-init.
 */
export async function ensureNatGatewayControlPlane(input: {
  cluster: ClusterId;
  namespace: string;
  vpcName: string;
  vmName: string;
  publicPrimaryCidr?: string;
  publicGateway?: string;
  privateCidr?: string;
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
      `Cluster "${input.cluster}" has no network.podCIDR/serviceCIDR in clusters.yaml — required for NAT gateway pod NIC + agent`,
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
      // If PEM, base64-encode for kubeconfig
      if (caData.includes("BEGIN CERTIFICATE")) {
        caData = Buffer.from(caData, "utf8").toString("base64");
      }
    }
  }
  if (!caData) {
    throw new Error(
      `Cluster "${input.cluster}" has no caData/caFile — required for NAT agent kubeconfig`,
    );
  }

  const { core, rbac } = getClusterClients(input.cluster);
  const ns = input.namespace;
  const vpc = input.vpcName;
  const cmName = natPolicyConfigMapName(vpc);
  const saName = natAgentServiceAccountName(vpc);
  const roleName = natAgentRoleName(vpc);
  const labels = {
    [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
    [KMC_LABEL_RESOURCE]: KMC_RESOURCE_NAT_POLICY,
    [KMC_LABEL_VPC]: vpc,
    [KMC_LABEL_ROLE]: KMC_ROLE_NAT_GATEWAY,
  };

  // ServiceAccount
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

  // Role: get/list/watch/patch the policy ConfigMap only
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

  const rbName = roleName;
  try {
    await rbac.createNamespacedRoleBinding({
      namespace: ns,
      body: {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name: rbName, namespace: ns, labels },
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
        `Failed to create RoleBinding ${ns}/${rbName}: ${formatError(err)}`,
        { cause: err },
      );
    }
  }

  // Long-lived token via TokenRequest (1 year)
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
    if (!token) {
      throw new Error("TokenRequest returned empty token");
    }
  } catch (err) {
    throw new Error(
      `Failed to mint ServiceAccount token for ${ns}/${saName}: ${formatError(err)}`,
      { cause: err },
    );
  }

  const doc = emptyPolicyDoc(vpc, {
    publicPrimaryCidr: input.publicPrimaryCidr,
    publicGateway: input.publicGateway,
    privateCidr: input.privateCidr,
  });
  const agentScript = normalizeAgentScript();

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
          // Intentionally no ownerReference to the NAT GW VM: policy (including
          // floating IPs) must survive gateway VM delete/recreate.
          annotations: {
            [KMC_ANN_AGENT_STATUS]: "Pending",
          },
        },
        data: {
          [KMC_NAT_POLICY_DATA_KEY]: JSON.stringify(doc, null, 2),
          [KMC_NAT_AGENT_SCRIPT_KEY]: agentScript,
        },
      },
    });
  } catch (err) {
    if (!isAlreadyExists(err)) {
      throw new Error(
        `Failed to create policy ConfigMap ${ns}/${cmName}: ${formatError(err)}`,
        { cause: err },
      );
    }
    // Existing CM (NAT GW recreate): keep floatingIPs, refresh interfaces + agent.
    await refreshExistingPolicyConfigMap(input.cluster, ns, vpc, {
      publicPrimaryCidr: input.publicPrimaryCidr,
      publicGateway: input.publicGateway,
      privateCidr: input.privateCidr,
      labels,
    });
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

/**
 * On NAT gateway recreate: preserve floating IP associations, update NIC metadata
 * for the new primary addresses, strip any ownerReference so GC cannot delete the
 * policy again, and roll out the latest agent script.
 */
async function refreshExistingPolicyConfigMap(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
  opts: {
    publicPrimaryCidr?: string;
    publicGateway?: string;
    privateCidr?: string;
    labels: Record<string, string>;
  },
): Promise<void> {
  const name = natPolicyConfigMapName(vpcName);
  const { core } = getClusterClients(cluster);
  const existing = await core.readNamespacedConfigMap({ name, namespace });
  const parsed = parsePolicyDoc(existing.data?.[KMC_NAT_POLICY_DATA_KEY]);
  const doc: NatGatewayPolicyDoc = parsed
    ? {
        ...parsed,
        floatingIPs: parsed.floatingIPs ?? [],
        publicInterface: {
          ...(parsed.publicInterface ?? {}),
          ...(opts.publicPrimaryCidr
            ? { primaryCidr: opts.publicPrimaryCidr }
            : {}),
          ...(opts.publicGateway ? { gateway: opts.publicGateway } : {}),
        },
        privateInterface: {
          ...(parsed.privateInterface ?? {}),
          ...(opts.privateCidr ? { cidr: opts.privateCidr } : {}),
        },
      }
    : emptyPolicyDoc(vpcName, {
        publicPrimaryCidr: opts.publicPrimaryCidr,
        publicGateway: opts.publicGateway,
        privateCidr: opts.privateCidr,
      });

  // Bump generation so a new agent instance re-applies DNAT/SNAT.
  doc.metadata.generation = (doc.metadata.generation || 0) + 1;
  doc.metadata.vpc = vpcName;

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
          ...opts.labels,
        },
        // Drop ownerReferences so deleting a NAT GW VM never GC's policy/floats.
        ownerReferences: [],
      },
      data: {
        ...(existing.data ?? {}),
        [KMC_NAT_POLICY_DATA_KEY]: JSON.stringify(doc, null, 2),
        [KMC_NAT_AGENT_SCRIPT_KEY]: normalizeAgentScript(),
      },
    },
  });
}

/**
 * Ensure the policy ConfigMap carries the current in-guest agent source so
 * running agents can self-update via watch.
 * Also detaches any ownerReference to a NAT GW VM so floating IP policy is not
 * garbage-collected when the gateway instance is deleted.
 */
export async function syncAgentScriptInPolicyConfigMap(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
): Promise<boolean> {
  const name = natPolicyConfigMapName(vpcName);
  const { core } = getClusterClients(cluster);
  const agentScript = normalizeAgentScript();
  try {
    const existing = await core.readNamespacedConfigMap({ name, namespace });
    const current = existing.data?.[KMC_NAT_AGENT_SCRIPT_KEY] ?? "";
    const scriptCurrent = normalizeAgentScript(current) === agentScript;
    const owners = existing.metadata?.ownerReferences ?? [];
    const needsDetach = owners.length > 0;
    if (scriptCurrent && !needsDetach) {
      return false;
    }
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
          // Clear owners so policy/floating IPs outlive the NAT gateway VM.
          ownerReferences: [],
        },
        data: {
          ...(existing.data ?? {}),
          [KMC_NAT_AGENT_SCRIPT_KEY]: agentScript,
        },
      },
    });
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw new Error(
      `Failed to sync agent script on ${namespace}/${name}: ${formatError(err)}`,
      { cause: err },
    );
  }
}

/** Best-effort cleanup of NAT control-plane objects (CM, SA, Role, RoleBinding). */
export async function deleteNatGatewayControlPlane(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
): Promise<void> {
  const { core, rbac } = getClusterClients(cluster);
  const cmName = natPolicyConfigMapName(vpcName);
  const saName = natAgentServiceAccountName(vpcName);
  const roleName = natAgentRoleName(vpcName);

  const ignore = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      if (!isNotFound(err)) {
        console.error("deleteNatGatewayControlPlane:", formatError(err));
      }
    }
  };

  await ignore(() => core.deleteNamespacedConfigMap({ name: cmName, namespace }));
  await ignore(() => rbac.deleteNamespacedRoleBinding({ name: roleName, namespace }));
  await ignore(() => rbac.deleteNamespacedRole({ name: roleName, namespace }));
  await ignore(() => core.deleteNamespacedServiceAccount({ name: saName, namespace }));
}

async function writePolicyDoc(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
  doc: NatGatewayPolicyDoc,
): Promise<void> {
  const name = natPolicyConfigMapName(vpcName);
  const { core } = getClusterClients(cluster);
  const existing = await core.readNamespacedConfigMap({ name, namespace });
  const nextGen = (doc.metadata.generation || 0) + 1;
  doc.metadata.generation = nextGen;
  // Opportunistically refresh agent.py so floating-IP ops also roll out agent updates.
  await core.replaceNamespacedConfigMap({
    name,
    namespace,
    body: {
      ...existing,
      data: {
        ...(existing.data ?? {}),
        [KMC_NAT_POLICY_DATA_KEY]: JSON.stringify(doc, null, 2),
        [KMC_NAT_AGENT_SCRIPT_KEY]: normalizeAgentScript(),
      },
    },
  });
}

/**
 * Stamp floating IPs onto the NAT gateway VM annotation for IPAM scans.
 */
export async function syncNatGatewayFloatingAnnotation(
  cluster: ClusterId,
  namespace: string,
  natGatewayVm: string,
  floats: FloatingIpAssociation[],
): Promise<void> {
  const { custom } = getClusterClients(cluster);
  const vm = (await custom.getNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace,
    plural: "virtualmachines",
    name: natGatewayVm,
  })) as {
    metadata?: { annotations?: Record<string, string> };
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
    name: natGatewayVm,
    body: {
      ...vm,
      metadata: {
        ...(vm.metadata as object),
        annotations,
      },
    },
  });
}

async function resolvePrivateTarget(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
  opts: { privateIpv4?: string; targetVm?: string; vpcCidr: string },
): Promise<{ privateIpv4: string; targetVm?: string }> {
  if (opts.privateIpv4?.trim()) {
    const addr =
      addressFromIpv4Annotation(opts.privateIpv4.trim()) ?? opts.privateIpv4.trim();
    const parsed = parseCidr(opts.vpcCidr);
    if (!containsIpv4(parsed, addr)) {
      throw new Error(`Private address ${addr} is outside VPC CIDR ${opts.vpcCidr}`);
    }
    return { privateIpv4: addr, targetVm: opts.targetVm?.trim() || undefined };
  }

  const vmName = opts.targetVm?.trim();
  if (!vmName) {
    throw new Error("privateIpv4 or targetVm is required");
  }

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
  const parsed = parseCidr(opts.vpcCidr);
  const match = parts.find((a) => containsIpv4(parsed, a));
  if (!match) {
    throw new Error(
      `VM ${namespace}/${vmName} has no IPAM address in VPC CIDR ${opts.vpcCidr}`,
    );
  }
  return { privateIpv4: match, targetVm: vmName };
}

function findFloatEntry(
  doc: NatGatewayPolicyDoc,
  idOrPublic: string,
): { index: number; entry: NatGatewayPolicyDoc["floatingIPs"][number] } | null {
  const key = idOrPublic.trim();
  if (!key) return null;
  const index = doc.floatingIPs.findIndex((f) => {
    const pub = addressFromIpv4Annotation(f.public) ?? f.public;
    return f.id === key || pub === key;
  });
  if (index < 0) return null;
  return { index, entry: doc.floatingIPs[index]! };
}

async function syncFloatAnnotationBestEffort(
  cluster: ClusterId,
  namespace: string,
  natGatewayVm: string | undefined,
  doc: NatGatewayPolicyDoc,
): Promise<void> {
  if (!natGatewayVm?.trim()) return;
  try {
    await syncNatGatewayFloatingAnnotation(
      cluster,
      namespace,
      natGatewayVm.trim(),
      floatingIpsFromPolicy(doc),
    );
  } catch (err) {
    console.error("syncNatGatewayFloatingAnnotation failed:", formatError(err));
  }
}

/**
 * Allocate (or use provided / held) public IP and map it to a private target.
 * Held FIPs (disassociated but not released) can be re-bound by public address.
 */
export async function associateFloatingIp(
  input: AssociateFloatingIpRequest & {
    vpcCidr: string;
    publicMultusNetwork: string;
    natGatewayVm: string;
  },
): Promise<FloatingIpAssociation> {
  const policy = await getNatPolicyConfigMap(
    input.cluster,
    input.namespace,
    input.vpcName,
  );
  if (!policy?.doc) {
    throw new Error(
      `No NAT policy ConfigMap for VPC ${input.namespace}/${input.vpcName} — create a NAT gateway first`,
    );
  }

  const { privateIpv4, targetVm } = await resolvePrivateTarget(
    input.cluster,
    input.namespace,
    input.vpcName,
    {
      privateIpv4: input.privateIpv4,
      targetVm: input.targetVm,
      vpcCidr: input.vpcCidr,
    },
  );

  // One associated float per private IP for v1 (held entries have no private).
  const existingPrivate = policy.doc.floatingIPs.find((f) => {
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
  const doc = policy.doc;

  // Re-associate a held public address when requested.
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
        protocol: held.protocol ?? "all",
      };
      await writePolicyDoc(input.cluster, input.namespace, input.vpcName, doc);
      await syncFloatAnnotationBestEffort(
        input.cluster,
        input.namespace,
        input.natGatewayVm,
        doc,
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

    // Already associated to another private?
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
    const poolParsed = parseCidr(publicPool.cidr);
    if (!containsIpv4(poolParsed, publicAddr)) {
      throw new Error(`Public address ${publicAddr} is outside pool ${publicPool.cidr}`);
    }
    // Ensure not already used: try allocate with preferred
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
    if (!alloc) {
      throw new Error("Could not allocate a public floating IP");
    }
    publicAddr = alloc.address;
  }

  // Defensive: policy entry already present (e.g. race)
  if (
    doc.floatingIPs.some(
      (f) => (addressFromIpv4Annotation(f.public) ?? f.public) === publicAddr,
    )
  ) {
    throw new Error(`Public address ${publicAddr} is already a floating IP`);
  }

  const id = `fip-${publicAddr.replace(/\./g, "-")}`;
  const assoc: FloatingIpAssociation = {
    id,
    public: publicAddr,
    prefix,
    private: privateIpv4,
    targetVm,
    state: "associated",
  };

  doc.floatingIPs = [
    ...doc.floatingIPs,
    {
      id: assoc.id,
      public: assoc.public,
      prefix: assoc.prefix,
      private: assoc.private,
      targetVm: assoc.targetVm,
      protocol: "all",
    },
  ];
  await writePolicyDoc(input.cluster, input.namespace, input.vpcName, doc);
  await syncFloatAnnotationBestEffort(
    input.cluster,
    input.namespace,
    input.natGatewayVm,
    doc,
  );

  return assoc;
}

/**
 * Unmap a floating IP from its private target but keep the public address
 * reserved for this VPC (held). Use {@link releaseFloatingIp} to return it
 * to the pool.
 */
export async function disassociateFloatingIp(
  input: DisassociateFloatingIpRequest & { natGatewayVm?: string },
): Promise<void> {
  const policy = await getNatPolicyConfigMap(
    input.cluster,
    input.namespace,
    input.vpcName,
  );
  if (!policy?.doc) {
    throw new Error(
      `No NAT policy ConfigMap for VPC ${input.namespace}/${input.vpcName}`,
    );
  }

  const found = findFloatEntry(policy.doc, input.idOrPublic);
  if (!found) {
    throw new Error(`Floating IP "${input.idOrPublic.trim()}" not found on this VPC`);
  }
  if (!found.entry.private?.trim()) {
    throw new Error(
      `Floating IP ${found.entry.public} is already held (not associated). Release it to return it to the pool.`,
    );
  }

  policy.doc.floatingIPs[found.index] = {
    id: found.entry.id,
    public: found.entry.public,
    prefix: found.entry.prefix,
    protocol: found.entry.protocol ?? "all",
    // Clear private/target → held
  };

  await writePolicyDoc(input.cluster, input.namespace, input.vpcName, policy.doc);
  await syncFloatAnnotationBestEffort(
    input.cluster,
    input.namespace,
    input.natGatewayVm,
    policy.doc,
  );
}

/**
 * Remove a floating IP from policy entirely so the public address returns to
 * the IPAM pool. Works for held or associated entries.
 */
export async function releaseFloatingIp(
  input: ReleaseFloatingIpRequest & { natGatewayVm?: string },
): Promise<void> {
  const policy = await getNatPolicyConfigMap(
    input.cluster,
    input.namespace,
    input.vpcName,
  );
  if (!policy?.doc) {
    throw new Error(
      `No NAT policy ConfigMap for VPC ${input.namespace}/${input.vpcName}`,
    );
  }

  const found = findFloatEntry(policy.doc, input.idOrPublic);
  if (!found) {
    throw new Error(`Floating IP "${input.idOrPublic.trim()}" not found on this VPC`);
  }

  policy.doc.floatingIPs = policy.doc.floatingIPs.filter((_, i) => i !== found.index);
  await writePolicyDoc(input.cluster, input.namespace, input.vpcName, policy.doc);
  await syncFloatAnnotationBestEffort(
    input.cluster,
    input.namespace,
    input.natGatewayVm,
    policy.doc,
  );
}

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
  if (apiStatusCode(err) === 409) return true;
  const message = formatError(err).toLowerCase();
  return message.includes("already exists") || message.includes("alreadyexists");
}

/**
 * List all floating IP associations from NAT policy ConfigMaps.
 */
export async function listFloatingIpsFromPolicies(
  cluster: ClusterId,
): Promise<FloatingIpSummary[]> {
  const { core } = getClusterClients(cluster);
  const items: FloatingIpSummary[] = [];
  try {
    const res = await core.listConfigMapForAllNamespaces({
      labelSelector: KMC_NAT_POLICY_LABEL_SELECTOR,
    });
    for (const cm of res.items ?? []) {
      const ns = cm.metadata?.namespace ?? "";
      const cmName = cm.metadata?.name ?? "";
      const vpcName =
        cm.metadata?.labels?.[KMC_LABEL_VPC]?.trim() ||
        parsePolicyDoc(cm.data?.[KMC_NAT_POLICY_DATA_KEY])?.metadata.vpc ||
        "";
      if (!ns || !vpcName) continue;
      const doc = parsePolicyDoc(cm.data?.[KMC_NAT_POLICY_DATA_KEY]);
      if (!doc) continue;
      const agent = agentInfoFromAnnotations(cm.metadata?.annotations ?? {});
      for (const f of doc.floatingIPs) {
        const privateAddr = f.private?.trim() || undefined;
        items.push({
          cluster,
          namespace: ns,
          vpcName,
          id: f.id,
          public: f.public,
          prefix: f.prefix,
          private: privateAddr,
          targetVm: privateAddr ? f.targetVm : undefined,
          state: floatingIpState({ private: privateAddr }),
          policyConfigMap: cmName,
          agentStatus: agent.agentStatus,
          agentHeartbeatAt: agent.agentHeartbeatAt,
        });
      }
    }
  } catch (err) {
    console.error(`listFloatingIpsFromPolicies(${cluster}):`, formatError(err));
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
  const { listFloatingIpsFromRouterPolicies } = await import(
    "~/vpcs/router-policy.server"
  );
  const [natAll, routerAll] = await Promise.all([
    listFloatingIpsFromPolicies(cluster),
    listFloatingIpsFromRouterPolicies(cluster),
  ]);
  const all = [...natAll, ...routerAll];
  const privSet = new Set(
    privateAddresses.map((a) => addressFromIpv4Annotation(a) ?? a.trim()).filter(Boolean),
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

/** Resolve cluster identity for tests/helpers. */
export function requireClusterIdentityExport(cluster: ClusterId) {
  return getClusterIdentity(cluster);
}
