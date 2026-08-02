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
  FloatingIpDetail,
  FloatingIpEligibleVpc,
  FloatingIpSummary,
  PortForwardAssociation,
  PortForwardDetail,
  PortForwardEligibleVpc,
  PortForwardSummary,
  ReleaseFloatingIpRequest,
  ReserveFloatingIpRequest,
  RouterAgentStatus,
  RouterSummary,
  UpdateVpcRequest,
  VpcAttachedVm,
  VpcDetail,
  VpcSummary,
} from "~/lib/types";
import {
  KMC_LABEL_ROLE,
  KMC_LABEL_ROUTER,
  KMC_LABEL_VPC,
  KMC_ROLE_ROUTER,
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
  findIpPoolForMultus,
  getIpPoolUsage,
  listIpPools,
  type IpPoolUsage,
} from "~/lib/ipam/pools.server";
import {
  clusterHasVlanPools,
  getVlanPool,
  listVlanPools,
} from "~/lib/ipam/vlan-pools.server";
import { DNS1123_LABEL, formatAge } from "~/lib/format";
import { listClusters } from "~/vms/vms.server";
import {
  createNamespacedCustomObject,
  deleteNamespacedCustomObject,
  getNamespacedCustomObject,
  isNotFoundError,
  KMC_API,
  kmcManagedLabels,
  listClusterCustomObjects,
  listNamespacedCustomObjects,
  mapCrConditions,
  ownerAnnotation,
  PLURAL_FLOATING_IPS,
  PLURAL_PORT_FORWARDS,
  PLURAL_ROUTERS,
  PLURAL_VPCS,
  portForwardObjectName,
  replaceNamespacedCustomObject,
  type FloatingIpCr,
  type PortForwardCr,
  type RouterCr,
  type VpcCr,
} from "~/lib/k8s/networking-cr.server";

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
      return undefined;
    } catch {
      /* fall through */
    }
  }
  return parts[0];
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

function mapVpcSummary(cluster: ClusterId, cr: VpcCr): VpcSummary {
  const vlan = cr.status?.vlan ?? 0;
  return {
    cluster,
    namespace: cr.metadata?.namespace ?? "default",
    name: cr.metadata?.name ?? "unknown",
    vlan: Number.isInteger(vlan) ? vlan : 0,
    vlanPoolId: cr.spec?.vlanPoolRef?.name,
    bridge: cr.status?.bridge?.trim() || undefined,
    cidr: cr.spec?.cidr?.trim() || undefined,
    gateway: cr.spec?.gateway?.trim() || undefined,
    dns: (cr.spec?.dns ?? []).map((d) => d.trim()).filter(Boolean),
    description: cr.spec?.description?.trim() || undefined,
    owner: cr.metadata?.annotations?.["kmc.ianunruh.com/owner"],
    age: cr.metadata?.creationTimestamp ?? "",
  };
}

function agentStatusFromRouter(r: RouterCr): RouterAgentStatus | undefined {
  const raw = r.status?.agent?.status?.trim();
  if (!raw) return undefined;
  if (raw === "Ready" || raw === "Error" || raw === "Pending" || raw === "Unknown") {
    return raw;
  }
  return "Unknown";
}

function routerSummaryFromCr(
  cluster: ClusterId,
  cr: RouterCr,
): RouterSummary {
  const name = cr.metadata?.name ?? "unknown";
  const namespace = cr.metadata?.namespace ?? "default";
  const ifaces = cr.status?.interfaces ?? cr.spec?.vpcs?.map((v) => ({ vpc: v.name })) ?? [];
  return {
    cluster,
    namespace,
    name,
    vpcNames: ifaces.map((i) => i.vpc).filter((v): v is string => Boolean(v)),
    hasExternal: Boolean(
      cr.status?.external?.multusNetwork?.trim() ||
        cr.spec?.external?.multusNetwork?.trim(),
    ),
    agentStatus: agentStatusFromRouter(cr),
    agentHeartbeatAt: cr.status?.agent?.heartbeatAt,
    age: cr.metadata?.creationTimestamp
      ? formatAge(cr.metadata.creationTimestamp)
      : "—",
  };
}

function floatingIpState(cr: FloatingIpCr): "associated" | "held" {
  if (cr.spec?.privateAddress?.trim()) return "associated";
  if (cr.status?.phase === "Associated") return "associated";
  return "held";
}

function mapFloatingIpAssociation(cr: FloatingIpCr): FloatingIpAssociation {
  const publicAddr =
    cr.status?.address?.trim() || cr.spec?.address?.trim() || "";
  const prefix = cr.status?.prefixLength ?? 32;
  const privateAddr = cr.spec?.privateAddress?.trim() || undefined;
  return {
    id: cr.metadata?.name ?? publicAddr,
    public: publicAddr,
    prefix,
    private: privateAddr,
    targetVm: cr.spec?.targetVM?.name,
    state: floatingIpState(cr),
  };
}

function mapFloatingIpSummary(
  cluster: ClusterId,
  cr: FloatingIpCr,
  router?: RouterCr | null,
): FloatingIpSummary {
  const assoc = mapFloatingIpAssociation(cr);
  return {
    cluster,
    namespace: cr.metadata?.namespace ?? "",
    vpcName: cr.spec?.vpcRef?.name ?? "",
    id: assoc.id,
    public: assoc.public,
    prefix: assoc.prefix,
    private: assoc.private,
    targetVm: assoc.targetVm,
    state: assoc.state,
    routerName:
      cr.spec?.routerRef?.name ||
      router?.metadata?.name ||
      undefined,
    agentStatus: router ? agentStatusFromRouter(router) : undefined,
    agentHeartbeatAt: router?.status?.agent?.heartbeatAt,
    policyConfigMap: router?.status?.policyConfigMap,
  };
}

function mapPortForwardAssociation(
  cr: PortForwardCr,
  vpcName?: string,
): PortForwardAssociation {
  const protocol =
    (cr.spec?.protocol ?? "TCP").toUpperCase() === "UDP" ? "udp" : "tcp";
  return {
    id: cr.metadata?.name ?? "",
    public: cr.spec?.publicAddress?.trim() ?? "",
    publicPort: cr.spec?.publicPort ?? 0,
    private: cr.spec?.privateAddress?.trim() ?? "",
    privatePort: cr.spec?.privatePort ?? 0,
    protocol,
    targetVm: cr.spec?.targetVM?.name,
    vpc: cr.spec?.vpcRef?.name ?? vpcName,
  };
}

function mapPortForwardSummary(
  cluster: ClusterId,
  cr: PortForwardCr,
  router?: RouterCr | null,
): PortForwardSummary {
  const assoc = mapPortForwardAssociation(cr);
  return {
    cluster,
    namespace: cr.metadata?.namespace ?? "",
    vpcName: cr.spec?.vpcRef?.name ?? "",
    id: assoc.id,
    public: assoc.public,
    publicPort: assoc.publicPort,
    private: assoc.private,
    privatePort: assoc.privatePort,
    protocol: assoc.protocol,
    targetVm: assoc.targetVm,
    routerName:
      cr.spec?.routerRef?.name ||
      router?.metadata?.name ||
      undefined,
    agentStatus: router ? agentStatusFromRouter(router) : undefined,
    agentHeartbeatAt: router?.status?.agent?.heartbeatAt,
    policyConfigMap: router?.status?.policyConfigMap,
  };
}

async function loadRouter(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<RouterCr | null> {
  try {
    return await getNamespacedCustomObject<RouterCr>(
      cluster,
      namespace,
      PLURAL_ROUTERS,
      name,
    );
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

async function resolvePublicPoolForRouter(
  cluster: ClusterId,
  router: RouterCr,
): Promise<{ poolId: string; multusNetwork: string }> {
  const multus =
    router.status?.external?.multusNetwork?.trim() ||
    router.spec?.external?.multusNetwork?.trim();
  if (!multus) {
    throw new Error(
      `Router ${router.metadata?.name} has no external Multus network`,
    );
  }
  const pool = await findIpPoolForMultus(cluster, multus);
  if (!pool) {
    throw new Error(
      `No IPPool found for external Multus network "${multus}" — create an IPPool CR`,
    );
  }
  return { poolId: pool.id, multusNetwork: multus };
}

async function resolvePrivateOnVpc(input: {
  cluster: ClusterId;
  namespace: string;
  vpcName: string;
  vpcCidr: string;
  privateIpv4?: string;
  targetVm?: string;
}): Promise<{ privateIpv4: string; targetVm?: string }> {
  let privateIpv4 = input.privateIpv4?.trim();
  const targetVm = input.targetVm?.trim() || undefined;

  if (!privateIpv4 && targetVm) {
    const { custom } = getClusterClients(input.cluster);
    const vm = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace: input.namespace,
      plural: "virtualmachines",
      name: targetVm,
    })) as KubeVm;
    const ann = vm.metadata?.annotations?.[IPAM_ANNOTATION_IPV4];
    const fromAnn = allocatedIpv4ForVpc(ann, input.vpcCidr);
    privateIpv4 = addressFromIpv4Annotation(fromAnn ?? "") ?? fromAnn;
  }

  if (!privateIpv4) {
    throw new Error("privateIpv4 or targetVm with IPAM address is required");
  }
  parseIpv4(privateIpv4);
  if (!containsIpv4(parseCidr(input.vpcCidr), privateIpv4)) {
    throw new Error(`private address ${privateIpv4} is outside ${input.vpcCidr}`);
  }
  return { privateIpv4, targetVm };
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
  const vlanPoolClusters: string[] = [];

  await Promise.all(
    contexts.map(async (id) => {
      const cluster = byId.get(id);
      if (cluster && !cluster.reachable) return;
      try {
        if (await clusterHasVlanPools(id)) vlanPoolClusters.push(id);
        const crs = await listClusterCustomObjects<VpcCr>(id, PLURAL_VPCS);
        for (const cr of crs) {
          items.push(mapVpcSummary(id, cr));
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
  let cr: VpcCr;
  try {
    cr = await getNamespacedCustomObject<VpcCr>(
      cluster,
      namespace,
      PLURAL_VPCS,
      name,
    );
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Response("VPC not found", { status: 404 });
    }
    throw new Error(formatError(err), { cause: err });
  }

  const summary = mapVpcSummary(cluster, cr);
  const [attachedVms, ipUsage, fipCrs, pfCrs] = await Promise.all([
    listAttachedVms(cluster, namespace, name, { cidr: summary.cidr }),
    summary.cidr
      ? getIpPoolUsage(cluster, `vpc:${namespace}/${name}`).catch(() => null)
      : Promise.resolve(null),
    listNamespacedCustomObjects<FloatingIpCr>(
      cluster,
      namespace,
      PLURAL_FLOATING_IPS,
    ).catch(() => [] as FloatingIpCr[]),
    listNamespacedCustomObjects<PortForwardCr>(
      cluster,
      namespace,
      PLURAL_PORT_FORWARDS,
    ).catch(() => [] as PortForwardCr[]),
  ]);

  let router: VpcDetail["router"];
  const routerName =
    cr.status?.routerRef?.name?.trim() ||
    undefined;
  if (routerName) {
    try {
      const rtr = await loadRouter(cluster, namespace, routerName);
      if (rtr) {
        router = routerSummaryFromCr(cluster, rtr);
      } else {
        router = {
          cluster,
          namespace,
          name: routerName,
          vpcNames: [name],
          hasExternal: false,
          age: "—",
        };
      }
    } catch {
      router = {
        cluster,
        namespace,
        name: routerName,
        vpcNames: [name],
        hasExternal: false,
        age: "—",
      };
    }
  }

  const floatingIps = fipCrs
    .filter((f) => f.spec?.vpcRef?.name === name)
    .map(mapFloatingIpAssociation);
  const portForwards = pfCrs
    .filter((p) => p.spec?.vpcRef?.name === name)
    .map((p) => mapPortForwardAssociation(p, name));

  return {
    ...summary,
    uid: cr.metadata?.uid,
    labels: cr.metadata?.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(cr.metadata?.annotations ?? {}).filter(
        ([k]) => !k.startsWith("kubectl.kubernetes.io/"),
      ),
    ),
    conditions: mapCrConditions(cr.status?.conditions),
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
    portForwards,
  };
}

/**
 * Static Multus networks with IP pools — candidates for router external gateway.
 */
export async function listPublicEgressNetworks(
  cluster: ClusterId,
  opts?: { excludeMultus?: string },
): Promise<
  Array<{
    id: string;
    multusNetwork: string;
    cidr: string;
    gateway?: string;
  }>
> {
  const exclude = opts?.excludeMultus?.trim();
  const pools = await listIpPools(cluster);
  return pools
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
  const obj = await getNamespacedCustomObject(
    cluster,
    namespace,
    PLURAL_VPCS,
    name,
  );
  return toResourceYaml(obj);
}

export async function createVpc(input: CreateVpcRequest): Promise<VpcSummary> {
  validateCreateVpcInput(input);
  await assertVmNamespaceAllowed(input.cluster, input.namespace);

  if (!(await clusterHasVlanPools(input.cluster))) {
    throw new Error(
      `Cluster "${input.cluster}" has no VLANPool CRs — apply a VLANPool (see deploy/controller/examples)`,
    );
  }

  const pool = await getVlanPool(input.cluster, input.vlanPoolId);
  if (!pool) {
    throw new Error(
      input.vlanPoolId?.trim()
        ? `VLAN pool "${input.vlanPoolId}" not found on cluster ${input.cluster}`
        : `No VLAN pool available on cluster ${input.cluster}`,
    );
  }

  const session = getRequestSession();
  const owner = session?.user?.githubLogin;
  const dns = (input.dns ?? []).map((d) => d.trim()).filter(Boolean);

  const body: VpcCr = {
    apiVersion: KMC_API,
    kind: "VPC",
    metadata: {
      name: input.name.trim(),
      namespace: input.namespace.trim(),
      labels: kmcManagedLabels(),
      annotations: ownerAnnotation(owner),
    },
    spec: {
      vlanPoolRef: { name: pool.id },
      ...(input.cidr?.trim()
        ? {
            cidr: input.cidr.trim(),
            ...(input.gateway?.trim() ? { gateway: input.gateway.trim() } : {}),
            ...(dns.length > 0 ? { dns } : {}),
          }
        : {}),
      ...(input.description?.trim()
        ? { description: input.description.trim() }
        : {}),
    },
  };

  try {
    const created = await createNamespacedCustomObject<VpcCr>(
      input.cluster,
      input.namespace,
      PLURAL_VPCS,
      body,
    );
    return mapVpcSummary(input.cluster, created);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export async function updateVpc(input: UpdateVpcRequest): Promise<VpcSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  validateVpcIpamFields(input);

  let existing: VpcCr;
  try {
    existing = await getNamespacedCustomObject<VpcCr>(
      input.cluster,
      input.namespace,
      PLURAL_VPCS,
      input.name,
    );
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(`VPC ${input.namespace}/${input.name} not found`);
    }
    throw new Error(formatError(err), { cause: err });
  }

  const dns = (input.dns ?? []).map((d) => d.trim()).filter(Boolean);
  const cidr = input.cidr?.trim();
  const next: VpcCr = {
    ...existing,
    spec: {
      ...existing.spec,
      vlanPoolRef: existing.spec?.vlanPoolRef ?? { name: "" },
      description: input.description?.trim() || undefined,
      ...(cidr
        ? {
            cidr,
            gateway: input.gateway?.trim() || undefined,
            dns: dns.length > 0 ? dns : undefined,
          }
        : {
            cidr: undefined,
            gateway: undefined,
            dns: undefined,
          }),
    },
  };

  // Clear IPAM fields when disabled
  if (!cidr && next.spec) {
    delete next.spec.cidr;
    delete next.spec.gateway;
    delete next.spec.dns;
  }

  try {
    const updated = await replaceNamespacedCustomObject<VpcCr>(
      input.cluster,
      input.namespace,
      PLURAL_VPCS,
      input.name,
      next,
    );
    return mapVpcSummary(input.cluster, updated);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export async function deleteVpc(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
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

  await deleteNamespacedCustomObject(cluster, namespace, PLURAL_VPCS, name);
}

export { listVlanPools, clusterHasVlanPools };
export type { IpPoolUsage };

export async function associateFloatingIp(
  input: AssociateFloatingIpRequest,
): Promise<FloatingIpAssociation> {
  const vpc = await getVpc(input.cluster, input.namespace, input.vpcName);
  if (!vpc.cidr?.trim()) throw new Error("VPC has no private CIDR");
  if (!vpc.router?.hasExternal || !vpc.router.name) {
    throw new Error(
      "VPC has no router external gateway — enable an external gateway on the shared router first",
    );
  }

  const router = await loadRouter(
    input.cluster,
    input.namespace,
    vpc.router.name,
  );
  if (!router) throw new Error(`Router ${vpc.router.name} not found`);
  const { poolId } = await resolvePublicPoolForRouter(input.cluster, router);
  const { privateIpv4, targetVm } = await resolvePrivateOnVpc({
    cluster: input.cluster,
    namespace: input.namespace,
    vpcName: input.vpcName,
    vpcCidr: vpc.cidr,
    privateIpv4: input.privateIpv4,
    targetVm: input.targetVm,
  });

  // Re-associate held FIP if public specified and exists
  const preferred = input.publicIpv4?.trim();
  if (preferred) {
    const existing = await findFloatingIpByPublic(
      input.cluster,
      input.namespace,
      preferred,
    );
    if (existing && existing.spec?.vpcRef?.name === input.vpcName) {
      const patched = await patchFloatingPrivate(
        input.cluster,
        input.namespace,
        existing,
        privateIpv4,
        targetVm,
      );
      return mapFloatingIpAssociation(patched);
    }
  }

  const body: FloatingIpCr = {
    apiVersion: KMC_API,
    kind: "FloatingIP",
    metadata: {
      name: preferred
        ? preferred.replaceAll(".", "-")
        : `fip-${input.vpcName}-${Date.now().toString(36)}`.slice(0, 63),
      namespace: input.namespace,
      labels: kmcManagedLabels(),
      generateName: preferred ? undefined : `fip-${input.vpcName}-`,
    },
    spec: {
      poolRef: { kind: "IPPool", name: poolId },
      ...(preferred ? { address: preferred } : {}),
      vpcRef: { name: input.vpcName },
      routerRef: { name: vpc.router.name },
      privateAddress: privateIpv4,
      ...(targetVm ? { targetVM: { name: targetVm } } : {}),
    },
  };

  // Prefer generateName when no preferred address
  if (!preferred) {
    delete body.metadata!.name;
    body.metadata!.generateName = `fip-${input.vpcName}-`;
  } else {
    delete body.metadata!.generateName;
  }

  const created = await createNamespacedCustomObject<FloatingIpCr>(
    input.cluster,
    input.namespace,
    PLURAL_FLOATING_IPS,
    body,
  );
  return mapFloatingIpAssociation(created);
}

/**
 * Wait until the FloatingIP controller has claimed a public address into
 * status.address (or fail on Error phase / timeout). Create responses are
 * often empty for pool-allocated addresses until the first reconcile.
 */
async function waitForFloatingIpAddress(
  cluster: ClusterId,
  namespace: string,
  name: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<FloatingIpCr> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const intervalMs = opts?.intervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;
  let last: FloatingIpCr | null = null;

  while (Date.now() < deadline) {
    last = await getNamespacedCustomObject<FloatingIpCr>(
      cluster,
      namespace,
      PLURAL_FLOATING_IPS,
      name,
    );
    const publicAddr =
      last.status?.address?.trim() || last.spec?.address?.trim() || "";
    if (publicAddr) return last;
    if (last.status?.phase === "Error") {
      const msg =
        last.status?.conditions?.find((c) => c.type === "Ready")?.message ||
        "FloatingIP allocation failed";
      throw new Error(msg);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `Timed out waiting for public address on FloatingIP ${namespace}/${name}` +
      (last?.status?.phase ? ` (phase ${last.status.phase})` : ""),
  );
}

export async function reserveFloatingIp(
  input: ReserveFloatingIpRequest,
): Promise<FloatingIpAssociation> {
  const vpc = await getVpc(input.cluster, input.namespace, input.vpcName);
  if (!vpc.cidr?.trim()) throw new Error("VPC has no private CIDR");
  if (!vpc.router?.hasExternal || !vpc.router.name) {
    throw new Error(
      "VPC has no router external gateway — enable an external gateway on the shared router first",
    );
  }
  const router = await loadRouter(
    input.cluster,
    input.namespace,
    vpc.router.name,
  );
  if (!router) throw new Error(`Router ${vpc.router.name} not found`);
  const { poolId } = await resolvePublicPoolForRouter(input.cluster, router);
  const preferred = input.publicIpv4?.trim();

  const body: FloatingIpCr = {
    apiVersion: KMC_API,
    kind: "FloatingIP",
    metadata: {
      ...(preferred
        ? { name: preferred.replaceAll(".", "-") }
        : { generateName: `fip-${input.vpcName}-` }),
      namespace: input.namespace,
      labels: kmcManagedLabels(),
    },
    spec: {
      poolRef: { kind: "IPPool", name: poolId },
      ...(preferred ? { address: preferred } : {}),
      vpcRef: { name: input.vpcName },
      routerRef: { name: vpc.router.name },
    },
  };

  const created = await createNamespacedCustomObject<FloatingIpCr>(
    input.cluster,
    input.namespace,
    PLURAL_FLOATING_IPS,
    body,
  );
  const name = created.metadata?.name?.trim();
  if (!name) throw new Error("FloatingIP create returned no object name");

  // Pool-allocated FIPs have empty status.address until the controller claims
  // an IPAddress. Callers (port-forward create) need the real public address.
  const ready = await waitForFloatingIpAddress(
    input.cluster,
    input.namespace,
    name,
  );
  return mapFloatingIpAssociation(ready);
}

async function findFloatingIpByPublic(
  cluster: ClusterId,
  namespace: string,
  idOrPublic: string,
): Promise<FloatingIpCr | null> {
  const key = idOrPublic.trim();
  if (!key) return null;
  const items = await listNamespacedCustomObjects<FloatingIpCr>(
    cluster,
    namespace,
    PLURAL_FLOATING_IPS,
  );
  const addr = addressFromIpv4Annotation(key) ?? key;
  for (const f of items) {
    if (f.metadata?.name === key) return f;
    const pub = f.status?.address?.trim() || f.spec?.address?.trim() || "";
    if (pub === addr || pub === key) return f;
  }
  return null;
}

async function patchFloatingPrivate(
  cluster: ClusterId,
  namespace: string,
  existing: FloatingIpCr,
  privateIpv4: string | undefined,
  targetVm: string | undefined,
): Promise<FloatingIpCr> {
  const next: FloatingIpCr = {
    ...existing,
    spec: {
      ...existing.spec,
      poolRef: existing.spec?.poolRef ?? { kind: "IPPool", name: "" },
      vpcRef: existing.spec?.vpcRef ?? { name: "" },
      privateAddress: privateIpv4,
      targetVM: targetVm ? { name: targetVm } : undefined,
    },
  };
  if (!privateIpv4 && next.spec) {
    delete next.spec.privateAddress;
    delete next.spec.targetVM;
  }
  return replaceNamespacedCustomObject<FloatingIpCr>(
    cluster,
    namespace,
    PLURAL_FLOATING_IPS,
    existing.metadata!.name!,
    next,
  );
}

export async function disassociateFloatingIp(
  input: DisassociateFloatingIpRequest,
): Promise<void> {
  const fip = await findFloatingIpByPublic(
    input.cluster,
    input.namespace,
    input.idOrPublic,
  );
  if (!fip) {
    throw new Error(`Floating IP "${input.idOrPublic}" not found`);
  }
  await patchFloatingPrivate(
    input.cluster,
    input.namespace,
    fip,
    undefined,
    undefined,
  );
}

export async function releaseFloatingIp(
  input: ReleaseFloatingIpRequest,
): Promise<void> {
  const fip = await findFloatingIpByPublic(
    input.cluster,
    input.namespace,
    input.idOrPublic,
  );
  if (!fip?.metadata?.name) {
    throw new Error(`Floating IP "${input.idOrPublic}" not found`);
  }
  await deleteNamespacedCustomObject(
    input.cluster,
    input.namespace,
    PLURAL_FLOATING_IPS,
    fip.metadata.name,
  );
}

export async function getFloatingIp(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<FloatingIpDetail> {
  let cr: FloatingIpCr | null = null;
  try {
    cr = await getNamespacedCustomObject<FloatingIpCr>(
      cluster,
      namespace,
      PLURAL_FLOATING_IPS,
      name,
    );
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw new Error(formatError(err), { cause: err });
    }
  }
  if (!cr) {
    // Allow lookup by public address when the path used the address form.
    cr = await findFloatingIpByPublic(cluster, namespace, name);
  }
  if (!cr?.metadata?.name) {
    throw new Response("Floating IP not found", { status: 404 });
  }

  const summary = mapFloatingIpSummary(cluster, cr);
  let router: RouterCr | null = null;
  const routerName =
    cr.spec?.routerRef?.name?.trim() || summary.routerName || undefined;
  if (routerName) {
    router = await loadRouter(cluster, namespace, routerName);
  }
  // Re-map with router for agent status when we had to load it after summary.
  const withRouter = mapFloatingIpSummary(cluster, cr, router);

  return {
    ...withRouter,
    name: cr.metadata.name,
    uid: cr.metadata.uid,
    labels: cr.metadata.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(cr.metadata.annotations ?? {}).filter(
        ([k]) => !k.startsWith("kubectl.kubernetes.io/"),
      ),
    ),
    age: cr.metadata.creationTimestamp ?? "",
    phase: cr.status?.phase,
    programmed: cr.status?.programmed,
    observedGeneration: cr.status?.observedGeneration,
    poolRef: cr.spec?.poolRef
      ? { kind: cr.spec.poolRef.kind, name: cr.spec.poolRef.name }
      : undefined,
    conditions: mapCrConditions(cr.status?.conditions),
  };
}

export async function getFloatingIpYaml(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<string> {
  // Resolve via get so public-address path segments still work.
  const detail = await getFloatingIp(cluster, namespace, name);
  const obj = await getNamespacedCustomObject(
    cluster,
    namespace,
    PLURAL_FLOATING_IPS,
    detail.name,
  );
  return toResourceYaml(obj);
}

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
        const [fips, routers] = await Promise.all([
          listClusterCustomObjects<FloatingIpCr>(id, PLURAL_FLOATING_IPS),
          listClusterCustomObjects<RouterCr>(id, PLURAL_ROUTERS).catch(
            () => [] as RouterCr[],
          ),
        ]);
        const routerByKey = new Map(
          routers.map((r) => [
            `${r.metadata?.namespace}/${r.metadata?.name}`,
            r,
          ]),
        );
        for (const f of fips) {
          const ns = f.metadata?.namespace ?? "";
          const rName =
            f.spec?.routerRef?.name ||
            undefined;
          const router = rName
            ? routerByKey.get(`${ns}/${rName}`)
            : undefined;
          items.push(mapFloatingIpSummary(id, f, router));
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
        const floats = detail.floatingIps ?? [];
        const router = await loadRouter(
          vpc.cluster,
          vpc.namespace,
          detail.router.name,
        );
        out.push({
          cluster: vpc.cluster,
          namespace: vpc.namespace,
          name: vpc.name,
          cidr: vpc.cidr,
          routerName: detail.router.name,
          publicNetwork:
            router?.status?.external?.multusNetwork ||
            router?.spec?.external?.multusNetwork,
          agentStatus: detail.router.agentStatus,
          floatingCount: floats.length,
          heldPublicIps: floats
            .filter((f) => f.state === "held")
            .map((f) => f.public),
          targetVms: detail.attachedVms
            .filter((vm) => !vm.isRouter)
            .map((vm) => ({
              name: vm.name,
              allocatedIpv4: vm.allocatedIpv4,
            })),
        });
      } catch {
        /* skip */
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

export async function listFloatingIpsForVm(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
  privateAddresses: string[] = [],
): Promise<FloatingIpSummary[]> {
  const privSet = new Set(
    privateAddresses
      .map((a) => addressFromIpv4Annotation(a) ?? a.trim())
      .filter(Boolean),
  );
  const items = await listNamespacedCustomObjects<FloatingIpCr>(
    cluster,
    namespace,
    PLURAL_FLOATING_IPS,
  );
  const routerCache = new Map<string, RouterCr | null>();
  const out: FloatingIpSummary[] = [];
  for (const f of items) {
    const target = f.spec?.targetVM?.name?.trim();
    const priv = f.spec?.privateAddress?.trim();
    const match =
      (target && target === vmName) ||
      (priv && privSet.has(addressFromIpv4Annotation(priv) ?? priv));
    if (!match) continue;
    const rName = f.spec?.routerRef?.name;
    let router: RouterCr | null | undefined;
    if (rName) {
      if (!routerCache.has(rName)) {
        routerCache.set(rName, await loadRouter(cluster, namespace, rName));
      }
      router = routerCache.get(rName);
    }
    out.push(mapFloatingIpSummary(cluster, f, router));
  }
  return out;
}

export async function createPortForward(
  input: CreatePortForwardRequest,
): Promise<PortForwardAssociation> {
  const vpc = await getVpc(input.cluster, input.namespace, input.vpcName);
  if (!vpc.cidr?.trim()) throw new Error("VPC has no private CIDR");
  if (!vpc.router?.hasExternal || !vpc.router.name) {
    throw new Error(
      "VPC has no router external gateway — enable an external gateway on the shared router first",
    );
  }
  const router = await loadRouter(
    input.cluster,
    input.namespace,
    vpc.router.name,
  );
  if (!router) throw new Error(`Router ${vpc.router.name} not found`);

  const { privateIpv4, targetVm } = await resolvePrivateOnVpc({
    cluster: input.cluster,
    namespace: input.namespace,
    vpcName: input.vpcName,
    vpcCidr: vpc.cidr,
    privateIpv4: input.privateIpv4,
    targetVm: input.targetVm,
  });

  let publicAddress = input.publicIpv4?.trim();
  if (!publicAddress && input.allocatePublic) {
    const held = await reserveFloatingIp({
      cluster: input.cluster,
      namespace: input.namespace,
      vpcName: input.vpcName,
    });
    publicAddress = held.public?.trim();
    if (!publicAddress) {
      // Do not fall back to router primary — that silently maps the rule to the
      // wrong public IP while leaving an orphaned held FIP.
      throw new Error(
        `Allocated FloatingIP ${held.id} but public address is not ready yet`,
      );
    }
  }
  if (!publicAddress) {
    const primary = router.status?.external?.primaryCidr?.trim();
    publicAddress = addressFromIpv4Annotation(primary ?? "") ?? primary?.split("/")[0];
  }
  if (!publicAddress) {
    throw new Error(
      "publicIpv4 is required (or set allocatePublic / configure router external primary)",
    );
  }

  const protocol = input.protocol === "udp" ? "UDP" : "TCP";
  const publicPort = input.publicPort;
  const privatePort = input.privatePort;
  if (
    !Number.isInteger(publicPort) ||
    publicPort < 1 ||
    publicPort > 65535 ||
    !Number.isInteger(privatePort) ||
    privatePort < 1 ||
    privatePort > 65535
  ) {
    throw new Error("publicPort and privatePort must be integers 1–65535");
  }

  const name = portForwardObjectName(publicAddress, protocol, publicPort);
  const body: PortForwardCr = {
    apiVersion: KMC_API,
    kind: "PortForward",
    metadata: {
      name,
      namespace: input.namespace,
      labels: kmcManagedLabels(),
    },
    spec: {
      vpcRef: { name: input.vpcName },
      routerRef: { name: vpc.router.name },
      publicAddress,
      publicPort,
      privateAddress: privateIpv4,
      privatePort,
      protocol,
      ...(targetVm ? { targetVM: { name: targetVm } } : {}),
    },
  };

  const created = await createNamespacedCustomObject<PortForwardCr>(
    input.cluster,
    input.namespace,
    PLURAL_PORT_FORWARDS,
    body,
  );
  return mapPortForwardAssociation(created, input.vpcName);
}

export async function deletePortForward(
  input: DeletePortForwardRequest,
): Promise<void> {
  const id = input.id.trim();
  if (!id) throw new Error("port forward id is required");
  await deleteNamespacedCustomObject(
    input.cluster,
    input.namespace,
    PLURAL_PORT_FORWARDS,
    id,
  );
}

export async function getPortForward(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<PortForwardDetail> {
  let cr: PortForwardCr;
  try {
    cr = await getNamespacedCustomObject<PortForwardCr>(
      cluster,
      namespace,
      PLURAL_PORT_FORWARDS,
      name,
    );
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Response("Port forward not found", { status: 404 });
    }
    throw new Error(formatError(err), { cause: err });
  }
  if (!cr.metadata?.name) {
    throw new Response("Port forward not found", { status: 404 });
  }

  let router: RouterCr | null = null;
  const routerName = cr.spec?.routerRef?.name?.trim();
  if (routerName) {
    router = await loadRouter(cluster, namespace, routerName);
  }
  const summary = mapPortForwardSummary(cluster, cr, router);

  return {
    ...summary,
    name: cr.metadata.name,
    uid: cr.metadata.uid,
    labels: cr.metadata.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(cr.metadata.annotations ?? {}).filter(
        ([k]) => !k.startsWith("kubectl.kubernetes.io/"),
      ),
    ),
    age: cr.metadata.creationTimestamp ?? "",
    phase: cr.status?.phase,
    programmed: cr.status?.programmed,
    observedGeneration: cr.status?.observedGeneration,
    conditions: mapCrConditions(cr.status?.conditions),
  };
}

export async function getPortForwardYaml(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<string> {
  const obj = await getNamespacedCustomObject(
    cluster,
    namespace,
    PLURAL_PORT_FORWARDS,
    name,
  );
  return toResourceYaml(obj);
}

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
        const [pfs, routers] = await Promise.all([
          listClusterCustomObjects<PortForwardCr>(id, PLURAL_PORT_FORWARDS),
          listClusterCustomObjects<RouterCr>(id, PLURAL_ROUTERS).catch(
            () => [] as RouterCr[],
          ),
        ]);
        const routerByKey = new Map(
          routers.map((r) => [
            `${r.metadata?.namespace}/${r.metadata?.name}`,
            r,
          ]),
        );
        for (const pf of pfs) {
          const ns = pf.metadata?.namespace ?? "";
          const rName = pf.spec?.routerRef?.name;
          const router = rName
            ? routerByKey.get(`${ns}/${rName}`)
            : undefined;
          items.push(mapPortForwardSummary(id, pf, router));
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
    const p = a.public.localeCompare(b.public);
    if (p) return p;
    return a.publicPort - b.publicPort;
  });

  return { items, clusters };
}

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
        const router = await loadRouter(
          vpc.cluster,
          vpc.namespace,
          detail.router.name,
        );
        if (!router) return;

        const externalPrimary =
          addressFromIpv4Annotation(
            router.status?.external?.primaryCidr ?? "",
          ) ??
          router.status?.external?.primaryCidr?.split("/")[0]?.trim();

        const fips = detail.floatingIps ?? [];
        const associatedPublics = new Set(
          fips
            .filter((f) => f.state === "associated")
            .map((f) => addressFromIpv4Annotation(f.public) ?? f.public),
        );
        const publicOpts = new Set<string>();
        if (externalPrimary && !associatedPublics.has(externalPrimary)) {
          publicOpts.add(externalPrimary);
        }
        for (const f of fips) {
          if (f.state === "held" && f.public) publicOpts.add(f.public);
        }
        for (const pf of detail.portForwards ?? []) {
          const pub = addressFromIpv4Annotation(pf.public) ?? pf.public;
          if (pub && !associatedPublics.has(pub)) publicOpts.add(pub);
        }

        out.push({
          cluster: vpc.cluster,
          namespace: vpc.namespace,
          name: vpc.name,
          cidr: vpc.cidr,
          routerName: detail.router.name,
          publicNetwork:
            router.status?.external?.multusNetwork ||
            router.spec?.external?.multusNetwork,
          externalPrimaryIpv4: externalPrimary,
          agentStatus: detail.router.agentStatus,
          portForwardCount: (detail.portForwards ?? []).length,
          publicIpv4Options: Array.from(publicOpts).sort(),
          targetVms: detail.attachedVms
            .filter((vm) => !vm.isRouter)
            .map((vm) => ({
              name: vm.name,
              allocatedIpv4: vm.allocatedIpv4,
            })),
        });
      } catch {
        /* skip */
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

export async function listPortForwardsForVm(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
  privateAddresses: string[] = [],
): Promise<PortForwardSummary[]> {
  const privSet = new Set(
    privateAddresses
      .map((a) => addressFromIpv4Annotation(a) ?? a.trim())
      .filter(Boolean),
  );
  const items = await listNamespacedCustomObjects<PortForwardCr>(
    cluster,
    namespace,
    PLURAL_PORT_FORWARDS,
  );
  const routerCache = new Map<string, RouterCr | null>();
  const out: PortForwardSummary[] = [];
  for (const pf of items) {
    const target = pf.spec?.targetVM?.name?.trim();
    const priv = pf.spec?.privateAddress?.trim();
    const match =
      (target && target === vmName) ||
      (priv && privSet.has(addressFromIpv4Annotation(priv) ?? priv));
    if (!match) continue;
    const rName = pf.spec?.routerRef?.name;
    let router: RouterCr | null | undefined;
    if (rName) {
      if (!routerCache.has(rName)) {
        routerCache.set(rName, await loadRouter(cluster, namespace, rName));
      }
      router = routerCache.get(rName);
    }
    out.push(mapPortForwardSummary(cluster, pf, router));
  }
  return out;
}
