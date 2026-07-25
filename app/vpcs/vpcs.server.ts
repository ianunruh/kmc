import { formatError } from "~/lib/errors";
import { getRequestSession } from "~/lib/auth/middleware.server";
import type {
  AssociateFloatingIpRequest,
  ClusterId,
  CreatePortForwardRequest,
  CreateVpcRequest,
  DeletePortForwardRequest,
  DisassociateFloatingIpRequest,
  FloatingIpAssociation,
  FloatingIpEligibleVpc,
  FloatingIpSummary,
  PortForwardAssociation,
  PortForwardEligibleVpc,
  PortForwardSummary,
  ReleaseFloatingIpRequest,
  UpdateVpcRequest,
  VpcAttachedVm,
  VpcDetail,
  VpcSummary,
} from "~/lib/types";
import {
  KMC_ANN_CIDR,
  KMC_ANN_DESCRIPTION,
  KMC_ANN_DNS,
  KMC_ANN_GATEWAY,
  KMC_ANN_OWNER,
  KMC_ANN_ROUTER,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_ROLE,
  KMC_LABEL_ROUTER,
  KMC_LABEL_VLAN,
  KMC_LABEL_VLAN_POOL,
  KMC_LABEL_VPC,
  KMC_RESOURCE_NETWORK,
  KMC_RESOURCE_VPC,
  KMC_ROLE_ROUTER,
  KMC_VPC_LABEL_SELECTOR,
  MANAGED_BY_LABEL,
  KMC_MANAGED_BY,
} from "~/lib/k8s/constants";
import { assertVmNamespaceAllowed } from "~/lib/k8s/catalog.server";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { toResourceYaml } from "~/lib/k8s/yaml.server";
import {
  addressFromIpv4Annotation,
  containsIpv4,
  formatIpv4,
  parseCidr,
  parseIpv4,
  usableHostRange,
} from "~/lib/ipam/cidr";
import { IPAM_ANNOTATION_IPV4 } from "~/lib/ipam/constants";
import {
  getIpPoolUsage,
  listIpPools,
  type IpPoolUsage,
} from "~/lib/ipam/pools.server";
import {
  allocateVlan,
  clusterHasVlanPools,
  getVlanPool,
  listVlanPools,
} from "~/lib/ipam/vlan-pools.server";
import { DNS1123_LABEL } from "~/lib/format";
import { listClusters } from "~/vms/vms.server";
import { buildNetworkAttachmentDefinition } from "./template.server";
import {
  associateRouterFloatingIp,
  createRouterPortForward,
  deleteRouterPortForward,
  disassociateRouterFloatingIp,
  externalPrimaryIpv4FromDoc,
  getRouterPolicyConfigMap,
  listFloatingIpsForVm as listFloatingIpsForVmCore,
  listFloatingIpsFromRouterPolicies,
  listPortForwardsForVm as listPortForwardsForVmCore,
  listPortForwardsFromRouterPolicies,
  releaseRouterFloatingIp,
  summaryFromRouterPolicy,
  syncRouterAgentScript,
} from "./router-policy.server";

type KubeNad = {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    config?: string;
  };
};

type KubeVm = {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec?: {
    template?: {
      spec?: {
        networks?: Array<{
          name?: string;
          multus?: { networkName?: string };
        }>;
      };
    };
  };
  status?: {
    printableStatus?: string;
    ready?: boolean;
  };
};

/**
 * Pick the IPAM address for this VPC from a VM's ipv4 annotation.
 * Multi-attach stores comma-separated cidrHost values — prefer the one inside
 * the VPC CIDR when known; otherwise the sole / first entry.
 */
function allocatedIpv4ForVpc(
  annotation: string | undefined,
  vpcCidr: string | undefined,
): string | undefined {
  if (!annotation?.trim()) return undefined;
  const parts = annotation
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  if (vpcCidr?.trim()) {
    try {
      const parsed = parseCidr(vpcCidr.trim());
      for (const part of parts) {
        const addr = addressFromIpv4Annotation(part);
        if (addr && containsIpv4(parsed, addr)) return part;
      }
      // No annotation address falls in this VPC's CIDR (pod-only IPAM, etc.)
      return undefined;
    } catch {
      /* fall through to first entry */
    }
  }

  return parts[0];
}

function isNotFound(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  return message.includes("404") || message.includes("not found");
}

function parseDnsAnnotation(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBridgeFromConfig(config: string | undefined): string | undefined {
  if (!config?.trim()) return undefined;
  try {
    const parsed = JSON.parse(config) as { bridge?: string };
    return parsed.bridge?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function mapSummary(cluster: ClusterId, nad: KubeNad): VpcSummary {
  const labels = nad.metadata?.labels ?? {};
  const ann = nad.metadata?.annotations ?? {};
  const vlanRaw = labels[KMC_LABEL_VLAN];
  const vlan = vlanRaw ? Number(vlanRaw) : 0;
  return {
    cluster,
    namespace: nad.metadata?.namespace ?? "default",
    name: nad.metadata?.name ?? "unknown",
    vlan: Number.isInteger(vlan) ? vlan : 0,
    vlanPoolId: labels[KMC_LABEL_VLAN_POOL],
    bridge: parseBridgeFromConfig(nad.spec?.config),
    cidr: ann[KMC_ANN_CIDR],
    gateway: ann[KMC_ANN_GATEWAY],
    dns: parseDnsAnnotation(ann[KMC_ANN_DNS]),
    description: ann[KMC_ANN_DESCRIPTION],
    owner: ann[KMC_ANN_OWNER],
    age: nad.metadata?.creationTimestamp ?? "",
  };
}

/**
 * kmc VPC NADs use resource=vpc. Static Multus (ipPools) use resource=network
 * and may still have a VLAN label — those must not count as VPCs.
 */
function isVpcNad(nad: KubeNad): boolean {
  const labels = nad.metadata?.labels ?? {};
  const resource = labels[KMC_LABEL_RESOURCE];
  if (resource === KMC_RESOURCE_VPC) return true;
  if (resource === KMC_RESOURCE_NETWORK) return false;
  // Legacy: managed VPC NAD before resource label was always set.
  return (
    labels[MANAGED_BY_LABEL] === KMC_MANAGED_BY && labels[KMC_LABEL_VLAN] != null
  );
}

function multusRefMatches(
  networkName: string | undefined,
  vpcNamespace: string,
  vpcName: string,
): boolean {
  if (!networkName?.trim()) return false;
  const n = networkName.trim();
  if (n === vpcName) return true;
  if (n === `${vpcNamespace}/${vpcName}`) return true;
  return false;
}

/** Validate optional IPAM fields (create + update). */
export function validateVpcIpamFields(input: {
  cidr?: string;
  gateway?: string;
  dns?: string[];
}): void {
  const cidr = input.cidr?.trim();
  if (cidr) {
    const parsed = parseCidr(cidr);
    const gw = input.gateway?.trim();
    if (gw) {
      parseIpv4(gw);
      if (!containsIpv4(parsed, gw)) {
        throw new Error(`gateway ${gw} is outside ${parsed.cidr}`);
      }
    }
    for (const d of input.dns ?? []) {
      if (d.trim()) parseIpv4(d.trim());
    }
  } else if (input.gateway?.trim()) {
    throw new Error("gateway requires cidr (enable private IPAM)");
  }
}

export function validateCreateVpcInput(input: CreateVpcRequest): void {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!DNS1123_LABEL.test(input.name.trim()) || input.name.trim().length > 63) {
    throw new Error(
      "name must be a DNS-1123 label (lowercase alphanumeric and hyphens, ≤63 chars)",
    );
  }
  validateVpcIpamFields(input);
}

/**
 * Apply description + optional IPAM annotations onto a NAD annotation map.
 * When IPAM is disabled (no cidr), removes cidr/gateway/dns keys.
 */
export function applyVpcMutableAnnotations(
  existing: Record<string, string>,
  input: {
    description?: string;
    cidr?: string;
    gateway?: string;
    dns?: string[];
  },
): Record<string, string> {
  const next = { ...existing };

  const desc = input.description?.trim();
  if (desc) {
    next[KMC_ANN_DESCRIPTION] = desc;
  } else {
    delete next[KMC_ANN_DESCRIPTION];
  }

  const cidr = input.cidr?.trim();
  if (cidr) {
    next[KMC_ANN_CIDR] = cidr;
    const gw = input.gateway?.trim();
    if (gw) {
      next[KMC_ANN_GATEWAY] = gw;
    } else {
      delete next[KMC_ANN_GATEWAY];
    }
    const dns = (input.dns ?? []).map((d) => d.trim()).filter(Boolean);
    if (dns.length > 0) {
      next[KMC_ANN_DNS] = dns.join(",");
    } else {
      delete next[KMC_ANN_DNS];
    }
  } else {
    delete next[KMC_ANN_CIDR];
    delete next[KMC_ANN_GATEWAY];
    delete next[KMC_ANN_DNS];
  }

  return next;
}

export async function listVpcs(clusterFilter?: ClusterId): Promise<{
  items: VpcSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
  vlanPoolClusters: string[];
}> {
  const contexts = clusterFilter ? [clusterFilter] : getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const items: VpcSummary[] = [];
  const vlanPoolClusters = contexts.filter((id) => clusterHasVlanPools(id));

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const { custom } = getClusterClients(id);
        let nads: KubeNad[] = [];
        try {
          const res = (await custom.listClusterCustomObject({
            group: "k8s.cni.cncf.io",
            version: "v1",
            plural: "network-attachment-definitions",
            labelSelector: KMC_VPC_LABEL_SELECTOR,
          })) as { items?: KubeNad[] };
          nads = res.items ?? [];
        } catch {
          const res = (await custom.listClusterCustomObject({
            group: "k8s.cni.cncf.io",
            version: "v1",
            plural: "network-attachment-definitions",
          })) as { items?: KubeNad[] };
          nads = (res.items ?? []).filter(isVpcNad);
        }
        for (const nad of nads) {
          if (!isVpcNad(nad)) continue;
          items.push(mapSummary(id, nad));
        }
      } catch (err) {
        if (cluster) {
          cluster.reachable = false;
          cluster.error = formatError(err);
        }
      }
    }),
  );

  items.sort((a, b) => {
    const c = a.cluster.localeCompare(b.cluster);
    if (c) return c;
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    return a.name.localeCompare(b.name);
  });

  return { items, clusters, vlanPoolClusters };
}

export async function listAttachedVms(
  cluster: ClusterId,
  namespace: string,
  name: string,
  opts?: { cidr?: string },
): Promise<VpcAttachedVm[]> {
  const { custom } = getClusterClients(cluster);
  const res = (await custom.listClusterCustomObject({
    group: "kubevirt.io",
    version: "v1",
    plural: "virtualmachines",
  })) as { items?: KubeVm[] };

  const attached: VpcAttachedVm[] = [];
  for (const vm of res.items ?? []) {
    const vmNs = vm.metadata?.namespace ?? "";
    const vmName = vm.metadata?.name ?? "";
    if (!vmName) continue;
    const networks = vm.spec?.template?.spec?.networks ?? [];
    for (const net of networks) {
      if (multusRefMatches(net.multus?.networkName, namespace, name)) {
        // Prefer same-namespace match for bare names; if bare name and VM is
        // in another ns, Multus would not resolve local NAD — still count
        // explicit ns/name refs from anywhere.
        const ref = net.multus?.networkName?.trim() ?? "";
        if (ref === name && vmNs !== namespace) continue;
        const ann = vm.metadata?.annotations?.[IPAM_ANNOTATION_IPV4];
        const labels = vm.metadata?.labels ?? {};
        const isRouter =
          labels[KMC_LABEL_ROLE] === KMC_ROLE_ROUTER &&
          (labels[KMC_LABEL_ROUTER] != null || labels[KMC_LABEL_VPC] === name);
        attached.push({
          cluster,
          namespace: vmNs,
          name: vmName,
          allocatedIpv4: allocatedIpv4ForVpc(ann, opts?.cidr),
          isRouter,
        });
        break;
      }
    }
  }
  attached.sort((a, b) => {
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    return a.name.localeCompare(b.name);
  });
  return attached;
}

export async function getVpc(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<VpcDetail> {
  const { custom } = getClusterClients(cluster);
  let nad: KubeNad;
  try {
    nad = (await custom.getNamespacedCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      namespace,
      plural: "network-attachment-definitions",
      name,
    })) as KubeNad;
  } catch (err) {
    if (isNotFound(err)) {
      throw new Response("VPC not found", { status: 404 });
    }
    throw new Error(formatError(err), { cause: err });
  }

  if (!isVpcNad(nad)) {
    throw new Response("Not a kmc-managed VPC", { status: 404 });
  }

  const summary = mapSummary(cluster, nad);
  const [attachedVms, ipUsage] = await Promise.all([
    listAttachedVms(cluster, namespace, name, { cidr: summary.cidr }),
    summary.cidr
      ? getIpPoolUsage(cluster, `vpc:${namespace}/${name}`).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Shared router pointer + floating IPs from router policy
  let router: VpcDetail["router"];
  let floatingIps: FloatingIpAssociation[] = [];
  const routerNameAnn = nad.metadata?.annotations?.[KMC_ANN_ROUTER]?.trim();
  if (routerNameAnn) {
    try {
      await syncRouterAgentScript(cluster, namespace, routerNameAnn).catch(
        () => false,
      );
      const rp = await getRouterPolicyConfigMap(cluster, namespace, routerNameAnn);
      if (rp) {
        router = summaryFromRouterPolicy(
          cluster,
          namespace,
          routerNameAnn,
          rp.doc,
          rp.annotations,
          rp.creationTimestamp,
        );
        floatingIps = (rp.doc?.floatingIPs ?? [])
          .filter((f) => {
            if (f.vpc === name) return true;
            if (!f.vpc && f.private && summary.cidr) {
              try {
                return containsIpv4(parseCidr(summary.cidr), f.private);
              } catch {
                return false;
              }
            }
            // held with no vpc: only if single-interface router
            if (!f.private && !f.vpc) {
              return (rp.doc?.interfaces?.length ?? 0) === 1;
            }
            return false;
          })
          .map((f) => ({
            id: f.id,
            public: f.public,
            prefix: f.prefix,
            private: f.private,
            targetVm: f.targetVm,
            state: (f.private?.trim() ? "associated" : "held") as
              | "associated"
              | "held",
          }));
      } else {
        router = {
          cluster,
          namespace,
          name: routerNameAnn,
          vpcNames: [name],
          hasExternal: false,
          age: "—",
        };
      }
    } catch {
      router = {
        cluster,
        namespace,
        name: routerNameAnn,
        vpcNames: [name],
        hasExternal: false,
        age: "—",
      };
    }
  }

  return {
    ...summary,
    uid: nad.metadata?.uid,
    labels: nad.metadata?.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(nad.metadata?.annotations ?? {}).filter(
        ([k]) => !k.startsWith("kubectl.kubernetes.io/"),
      ),
    ),
    attachedVms,
    attachedCount: attachedVms.length,
    router,
    ipPool: ipUsage
      ? {
          id: ipUsage.pool.id,
          cidr: ipUsage.cidr,
          free: ipUsage.free,
          total: ipUsage.total,
          gateway: ipUsage.pool.gateway,
        }
      : undefined,
    floatingIps,
  };
}

/**
 * Static Multus networks with IP pools — candidates for router external gateway.
 * Excludes the VPC itself when it is also listed as an ipPool multusNetwork.
 */
export function listPublicEgressNetworks(
  cluster: ClusterId,
  opts?: { excludeMultus?: string },
): Array<{
  id: string;
  multusNetwork: string;
  cidr: string;
  gateway?: string;
}> {
  const exclude = opts?.excludeMultus?.trim();
  return listIpPools(cluster)
    .filter((p) => {
      if (!exclude) return true;
      return !multusRefMatches(p.multusNetwork, "", exclude);
    })
    .map((p) => ({
      id: p.id,
      multusNetwork: p.multusNetwork,
      cidr: p.cidr,
      gateway: p.gateway,
    }));
}

/**
 * First usable host in a CIDR (network+1 for prefix ≤ 30) — default VPC gateway.
 */
export function defaultGatewayAddress(cidr: string): string {
  const parsed = parseCidr(cidr);
  const range = usableHostRange(parsed);
  return formatIpv4(range.start);
}

export async function getVpcYaml(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<string> {
  const { custom } = getClusterClients(cluster);
  const obj = await custom.getNamespacedCustomObject({
    group: "k8s.cni.cncf.io",
    version: "v1",
    namespace,
    plural: "network-attachment-definitions",
    name,
  });
  return toResourceYaml(obj);
}

export async function createVpc(input: CreateVpcRequest): Promise<VpcSummary> {
  validateCreateVpcInput(input);
  await assertVmNamespaceAllowed(input.cluster, input.namespace);

  if (!clusterHasVlanPools(input.cluster)) {
    throw new Error(
      `Cluster "${input.cluster}" has no vlanPools configured — add vlanPools to clusters.yaml`,
    );
  }

  const poolHint = getVlanPool(input.cluster, input.vlanPoolId);
  if (input.vlanPoolId?.trim() && !poolHint) {
    throw new Error(
      `VLAN pool "${input.vlanPoolId}" not found on cluster ${input.cluster}`,
    );
  }

  const { pool, vlan } = await allocateVlan(input.cluster, input.vlanPoolId);
  const session = getRequestSession();
  const owner = session?.user?.githubLogin;

  const body = buildNetworkAttachmentDefinition({
    ...input,
    vlan,
    vlanPoolId: pool.id,
    bridge: pool.bridge,
    defaultDns: pool.dns,
    owner,
  });

  const { custom } = getClusterClients(input.cluster);
  try {
    const created = (await custom.createNamespacedCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      namespace: input.namespace,
      plural: "network-attachment-definitions",
      body,
    })) as KubeNad;
    return mapSummary(input.cluster, created);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export async function updateVpc(input: UpdateVpcRequest): Promise<VpcSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  validateVpcIpamFields(input);

  const { custom } = getClusterClients(input.cluster);
  let existing: KubeNad;
  try {
    existing = (await custom.getNamespacedCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      namespace: input.namespace,
      plural: "network-attachment-definitions",
      name: input.name,
    })) as KubeNad;
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(`VPC ${input.namespace}/${input.name} not found`);
    }
    throw new Error(formatError(err), { cause: err });
  }

  if (!isVpcNad(existing)) {
    throw new Error(`${input.namespace}/${input.name} is not a kmc-managed VPC`);
  }

  const annotations = applyVpcMutableAnnotations(existing.metadata?.annotations ?? {}, {
    description: input.description,
    cidr: input.cidr,
    gateway: input.gateway,
    dns: input.dns,
  });

  const body = {
    ...existing,
    metadata: {
      ...existing.metadata,
      annotations,
    },
  };

  try {
    const updated = (await custom.replaceNamespacedCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      namespace: input.namespace,
      plural: "network-attachment-definitions",
      name: input.name,
      body,
    })) as KubeNad;
    return mapSummary(input.cluster, updated);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export async function deleteVpc(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  // Ensure it is a managed VPC
  await getVpc(cluster, namespace, name);

  const attached = await listAttachedVms(cluster, namespace, name);
  if (attached.length > 0) {
    const sample = attached
      .slice(0, 5)
      .map((vm) => `${vm.namespace}/${vm.name}`)
      .join(", ");
    const more = attached.length > 5 ? ` (+${attached.length - 5} more)` : "";
    throw new Error(
      `Cannot delete VPC: ${attached.length} VM(s) still attached (${sample}${more})`,
    );
  }

  const { custom } = getClusterClients(cluster);
  try {
    await custom.deleteNamespacedCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      namespace,
      plural: "network-attachment-definitions",
      name,
    });
  } catch (err) {
    if (isNotFound(err)) return;
    throw new Error(formatError(err), { cause: err });
  }

}

export { listVlanPools, clusterHasVlanPools };
export type { IpPoolUsage };

/**
 * Associate a floating public IP via a shared router external gateway.
 */
export async function associateFloatingIp(
  input: AssociateFloatingIpRequest,
): Promise<FloatingIpAssociation> {
  const vpc = await getVpc(input.cluster, input.namespace, input.vpcName);
  if (!vpc.cidr?.trim()) {
    throw new Error("VPC has no private CIDR");
  }
  if (!vpc.router?.hasExternal || !vpc.router.name) {
    throw new Error(
      "VPC has no router external gateway — enable an external gateway on the shared router first",
    );
  }
  const rp = await getRouterPolicyConfigMap(
    input.cluster,
    input.namespace,
    vpc.router.name,
  );
  const publicNet = rp?.doc?.external?.multusNetwork?.trim();
  if (!publicNet) {
    throw new Error(
      `Router ${vpc.router.name} has no external Multus network in policy`,
    );
  }
  return associateRouterFloatingIp({
    ...input,
    routerName: vpc.router.name,
    vpcCidr: vpc.cidr,
    publicMultusNetwork: publicNet,
  });
}

export async function disassociateFloatingIp(
  input: DisassociateFloatingIpRequest,
): Promise<void> {
  const vpc = await getVpc(input.cluster, input.namespace, input.vpcName);
  if (!vpc.router?.name) {
    throw new Error(
      "VPC has no shared router — floating IPs are managed by router policy",
    );
  }
  await disassociateRouterFloatingIp({
    ...input,
    routerName: vpc.router.name,
  });
}

/** Drop a floating IP from policy so the public address returns to the pool. */
export async function releaseFloatingIp(
  input: ReleaseFloatingIpRequest,
): Promise<void> {
  const vpc = await getVpc(input.cluster, input.namespace, input.vpcName);
  if (!vpc.router?.name) {
    throw new Error(
      "VPC has no shared router — floating IPs are managed by router policy",
    );
  }
  await releaseRouterFloatingIp({
    ...input,
    routerName: vpc.router.name,
  });
}

/** Cross-cluster floating IP inventory for the top-level list. */
export async function listFloatingIps(clusterFilter?: ClusterId): Promise<{
  items: FloatingIpSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const contexts = clusterFilter ? [clusterFilter] : getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const items: FloatingIpSummary[] = [];

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const rows = await listFloatingIpsFromRouterPolicies(id);
        const gwCache = new Map<string, string | undefined>();
        const { custom } = getClusterClients(id);
        for (const row of rows) {
          if (!row.routerName) {
            const key = `${row.namespace}/${row.vpcName}`;
            if (!gwCache.has(key)) {
              try {
                const nad = (await custom.getNamespacedCustomObject({
                  group: "k8s.cni.cncf.io",
                  version: "v1",
                  namespace: row.namespace,
                  plural: "network-attachment-definitions",
                  name: row.vpcName,
                })) as KubeNad;
                gwCache.set(
                  key,
                  nad.metadata?.annotations?.[KMC_ANN_ROUTER]?.trim(),
                );
              } catch {
                gwCache.set(key, undefined);
              }
            }
            row.routerName = gwCache.get(key);
          }
          items.push(row);
        }
      } catch (err) {
        if (cluster) {
          cluster.reachable = false;
          cluster.error = formatError(err);
        }
      }
    }),
  );

  items.sort((a, b) => {
    const c = a.cluster.localeCompare(b.cluster);
    if (c) return c;
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    return a.public.localeCompare(b.public);
  });

  return { items, clusters };
}

/**
 * VPCs that can accept floating associations (router with external gateway).
 */
export async function listFloatingIpEligibleVpcs(
  clusterFilter?: ClusterId,
): Promise<FloatingIpEligibleVpc[]> {
  const { items: vpcs } = await listVpcs(clusterFilter);
  const out: FloatingIpEligibleVpc[] = [];

  await Promise.all(
    vpcs.map(async (vpc) => {
      if (!vpc.cidr?.trim()) return;
      try {
        const detail = await getVpc(vpc.cluster, vpc.namespace, vpc.name);
        if (!detail.router?.hasExternal || !detail.router.name) return;

        const rp = await getRouterPolicyConfigMap(
          vpc.cluster,
          vpc.namespace,
          detail.router.name,
        );
        const floats = rp?.doc
          ? (rp.doc.floatingIPs ?? []).filter(
              (f) =>
                f.vpc === vpc.name ||
                (!f.vpc &&
                  f.private &&
                  containsIpv4(parseCidr(vpc.cidr!), f.private)),
            )
          : [];
        out.push({
          cluster: vpc.cluster,
          namespace: vpc.namespace,
          name: vpc.name,
          cidr: vpc.cidr,
          routerName: detail.router.name,
          publicNetwork: rp?.doc?.external?.multusNetwork,
          agentStatus: detail.router.agentStatus,
          floatingCount: floats.length,
          heldPublicIps: floats
            .filter((f) => !f.private?.trim())
            .map((f) => f.public),
          targetVms: detail.attachedVms
            .filter((vm) => !vm.isRouter)
            .map((vm) => ({
              name: vm.name,
              allocatedIpv4: vm.allocatedIpv4,
            })),
        });
      } catch {
        /* skip unreachable VPC */
      }
    }),
  );

  out.sort((a, b) => {
    const c = a.cluster.localeCompare(b.cluster);
    if (c) return c;
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** Floating IPs targeting a VM (by name or private IPAM addresses). */
export async function listFloatingIpsForVm(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
  privateAddresses: string[] = [],
): Promise<FloatingIpSummary[]> {
  return listFloatingIpsForVmCore(cluster, namespace, vmName, privateAddresses);
}

/**
 * Create a port forward (publicIP:port → privateIP:port) via the VPC's shared router.
 */
export async function createPortForward(
  input: CreatePortForwardRequest,
): Promise<PortForwardAssociation> {
  const vpc = await getVpc(input.cluster, input.namespace, input.vpcName);
  if (!vpc.cidr?.trim()) {
    throw new Error("VPC has no private CIDR");
  }
  if (!vpc.router?.hasExternal || !vpc.router.name) {
    throw new Error(
      "VPC has no router external gateway — enable an external gateway on the shared router first",
    );
  }
  const rp = await getRouterPolicyConfigMap(
    input.cluster,
    input.namespace,
    vpc.router.name,
  );
  const publicNet = rp?.doc?.external?.multusNetwork?.trim();
  if (!publicNet) {
    throw new Error(
      `Router ${vpc.router.name} has no external Multus network in policy`,
    );
  }
  return createRouterPortForward({
    ...input,
    routerName: vpc.router.name,
    vpcCidr: vpc.cidr,
    publicMultusNetwork: publicNet,
  });
}

export async function deletePortForward(input: DeletePortForwardRequest): Promise<void> {
  const vpc = await getVpc(input.cluster, input.namespace, input.vpcName);
  if (!vpc.router?.name) {
    throw new Error(
      "VPC has no shared router — port forwards are managed by router policy",
    );
  }
  await deleteRouterPortForward({
    ...input,
    routerName: vpc.router.name,
  });
}

/** Cross-cluster port forward inventory. */
export async function listPortForwards(clusterFilter?: ClusterId): Promise<{
  items: PortForwardSummary[];
  clusters: Awaited<ReturnType<typeof listClusters>>;
}> {
  const contexts = clusterFilter ? [clusterFilter] : getConfiguredContexts();
  const clusters = await listClusters();
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const items: PortForwardSummary[] = [];

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        const rows = await listPortForwardsFromRouterPolicies(id);
        items.push(...rows);
      } catch (err) {
        if (cluster) {
          cluster.reachable = false;
          cluster.error = formatError(err);
        }
      }
    }),
  );

  items.sort((a, b) => {
    const c = a.cluster.localeCompare(b.cluster);
    if (c) return c;
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    const p = a.public.localeCompare(b.public);
    if (p) return p;
    return a.publicPort - b.publicPort;
  });

  return { items, clusters };
}

/**
 * VPCs that can accept port forwards (router with external gateway).
 */
export async function listPortForwardEligibleVpcs(
  clusterFilter?: ClusterId,
): Promise<PortForwardEligibleVpc[]> {
  const { items: vpcs } = await listVpcs(clusterFilter);
  const out: PortForwardEligibleVpc[] = [];

  await Promise.all(
    vpcs.map(async (vpc) => {
      if (!vpc.cidr?.trim()) return;
      try {
        const detail = await getVpc(vpc.cluster, vpc.namespace, vpc.name);
        if (!detail.router?.hasExternal || !detail.router.name) return;

        const rp = await getRouterPolicyConfigMap(
          vpc.cluster,
          vpc.namespace,
          detail.router.name,
        );
        if (!rp?.doc) return;
        const doc = rp.doc;
        const externalPrimary = externalPrimaryIpv4FromDoc(doc);
        const associatedPublics = new Set(
          (doc.floatingIPs ?? [])
            .filter((f) => f.private?.trim())
            .map((f) => addressFromIpv4Annotation(f.public) ?? f.public),
        );
        const publicOpts = new Set<string>();
        if (externalPrimary && !associatedPublics.has(externalPrimary)) {
          publicOpts.add(externalPrimary);
        }
        for (const f of doc.floatingIPs ?? []) {
          const pub = addressFromIpv4Annotation(f.public) ?? f.public;
          if (!f.private?.trim() && pub) publicOpts.add(pub);
        }
        for (const pf of doc.portForwards ?? []) {
          const pub = addressFromIpv4Annotation(pf.public) ?? pf.public;
          if (pub && !associatedPublics.has(pub)) publicOpts.add(pub);
        }
        const pfs = (doc.portForwards ?? []).filter(
          (pf) =>
            pf.vpc === vpc.name ||
            (!pf.vpc &&
              pf.private &&
              containsIpv4(parseCidr(vpc.cidr!), pf.private)),
        );
        out.push({
          cluster: vpc.cluster,
          namespace: vpc.namespace,
          name: vpc.name,
          cidr: vpc.cidr,
          routerName: detail.router.name,
          publicNetwork: doc.external?.multusNetwork,
          externalPrimaryIpv4: externalPrimary,
          agentStatus: detail.router.agentStatus,
          portForwardCount: pfs.length,
          publicIpv4Options: Array.from(publicOpts).sort(),
          targetVms: detail.attachedVms
            .filter((vm) => !vm.isRouter)
            .map((vm) => ({
              name: vm.name,
              allocatedIpv4: vm.allocatedIpv4,
            })),
        });
      } catch {
        /* skip unreachable VPC */
      }
    }),
  );

  out.sort((a, b) => {
    const c = a.cluster.localeCompare(b.cluster);
    if (c) return c;
    const n = a.namespace.localeCompare(b.namespace);
    if (n) return n;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** Port forwards targeting a VM (by name or private IPAM addresses). */
export async function listPortForwardsForVm(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
  privateAddresses: string[] = [],
): Promise<PortForwardSummary[]> {
  return listPortForwardsForVmCore(cluster, namespace, vmName, privateAddresses);
}
