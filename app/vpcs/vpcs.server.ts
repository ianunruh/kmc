import { formatError } from "~/lib/errors";
import { getRequestSession } from "~/lib/auth/middleware.server";
import type {
  ClusterId,
  CreateNatGatewayRequest,
  CreateVpcRequest,
  NatGatewayInfo,
  UpdateVpcRequest,
  VmSummary,
  VpcAttachedVm,
  VpcDetail,
  VpcSummary,
} from "~/lib/types";
import {
  KMC_ANN_CIDR,
  KMC_ANN_DESCRIPTION,
  KMC_ANN_DNS,
  KMC_ANN_GATEWAY,
  KMC_ANN_NAT_GATEWAY,
  KMC_ANN_OWNER,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_ROLE,
  KMC_LABEL_VLAN,
  KMC_LABEL_VLAN_POOL,
  KMC_LABEL_VPC,
  KMC_RESOURCE_VPC,
  KMC_ROLE_NAT_GATEWAY,
  KMC_VPC_LABEL_SELECTOR,
  MANAGED_BY_LABEL,
  KMC_MANAGED_BY,
} from "~/lib/k8s/constants";
import {
  assertVmNamespaceAllowed,
  getImagePreference,
} from "~/lib/k8s/catalog.server";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { ensureStaticMultusNads } from "~/lib/k8s/static-nads.server";
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
  allocateIpv4ForMultus,
  findIpPoolForMultus,
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
import {
  bindAllocationsToNetworks,
  buildNatGatewayUserData,
  buildVirtualMachineManifest,
  cloudInitUserDataSecretName,
} from "~/vms/template.server";
import { listClusters } from "~/vms/vms.server";
import { buildNetworkAttachmentDefinition } from "./template.server";

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

function isVpcNad(nad: KubeNad): boolean {
  const labels = nad.metadata?.labels ?? {};
  return (
    labels[KMC_LABEL_RESOURCE] === KMC_RESOURCE_VPC ||
    (labels[MANAGED_BY_LABEL] === KMC_MANAGED_BY &&
      labels[KMC_LABEL_VLAN] != null)
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
        const isNatGateway =
          labels[KMC_LABEL_ROLE] === KMC_ROLE_NAT_GATEWAY &&
          labels[KMC_LABEL_VPC] === name;
        attached.push({
          cluster,
          namespace: vmNs,
          name: vmName,
          allocatedIpv4: allocatedIpv4ForVpc(ann, opts?.cidr),
          isNatGateway,
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

  const natGatewayBase = findNatGatewayInfo(
    cluster,
    namespace,
    name,
    attachedVms,
    nad.metadata?.annotations ?? {},
  );
  const natGateway = await enrichNatGateway(
    cluster,
    namespace,
    name,
    summary.cidr,
    natGatewayBase,
  );

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
    ipPool: ipUsage
      ? {
          id: ipUsage.pool.id,
          cidr: ipUsage.cidr,
          free: ipUsage.free,
          total: ipUsage.total,
          gateway: ipUsage.pool.gateway,
        }
      : undefined,
    natGateway,
  };
}

/**
 * Static Multus networks with IP pools — candidates for NAT gateway egress.
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

function findNatGatewayInfo(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
  attachedVms: VpcAttachedVm[],
  vpcAnnotations: Record<string, string>,
): NatGatewayInfo | undefined {
  const fromLabel = attachedVms.find((vm) => vm.isNatGateway);
  const annName = vpcAnnotations[KMC_ANN_NAT_GATEWAY]?.trim();
  const pick =
    fromLabel ??
    (annName
      ? attachedVms.find((vm) => vm.name === annName && vm.namespace === namespace)
      : undefined);
  if (!pick) return undefined;

  return {
    cluster,
    namespace: pick.namespace,
    name: pick.name,
    privateIpv4: pick.allocatedIpv4,
  };
}

/**
 * First usable host in a CIDR (network+1 for prefix ≤ 30) — default VPC gateway.
 */
export function defaultGatewayAddress(cidr: string): string {
  const parsed = parseCidr(cidr);
  const range = usableHostRange(parsed);
  return formatIpv4(range.start);
}

function publicIpv4FromAnnotation(
  annotation: string | undefined,
  vpcCidr: string | undefined,
): string | undefined {
  if (!annotation?.trim()) return undefined;
  const parts = annotation
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  if (!vpcCidr?.trim()) {
    return parts.length > 1 ? parts[1] : undefined;
  }
  try {
    const parsed = parseCidr(vpcCidr.trim());
    for (const part of parts) {
      const addr = addressFromIpv4Annotation(part);
      if (addr && !containsIpv4(parsed, addr)) return part;
    }
  } catch {
    /* fall through */
  }
  return parts.length > 1 ? parts[1] : undefined;
}

async function enrichNatGateway(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
  vpcCidr: string | undefined,
  base: NatGatewayInfo | undefined,
): Promise<NatGatewayInfo | undefined> {
  if (!base) return undefined;
  const { custom } = getClusterClients(cluster);
  try {
    const vm = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace: base.namespace,
      plural: "virtualmachines",
      name: base.name,
    })) as KubeVm;
    const ann = vm.metadata?.annotations?.[IPAM_ANNOTATION_IPV4];
    const privateIpv4 =
      allocatedIpv4ForVpc(ann, vpcCidr) ?? base.privateIpv4;
    const publicIpv4 = publicIpv4FromAnnotation(ann, vpcCidr);
    const networks = vm.spec?.template?.spec?.networks ?? [];
    let publicNetwork: string | undefined;
    for (const net of networks) {
      const ref = net.multus?.networkName?.trim();
      if (!ref) continue;
      if (multusRefMatches(ref, namespace, vpcName)) continue;
      publicNetwork = ref;
      break;
    }
    return {
      ...base,
      privateIpv4,
      publicIpv4,
      publicNetwork,
    };
  } catch {
    return base;
  }
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
    throw new Error(
      `${input.namespace}/${input.name} is not a kmc-managed VPC`,
    );
  }

  const annotations = applyVpcMutableAnnotations(
    existing.metadata?.annotations ?? {},
    {
      description: input.description,
      cidr: input.cidr,
      gateway: input.gateway,
      dns: input.dns,
    },
  );

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
    const more =
      attached.length > 5 ? ` (+${attached.length - 5} more)` : "";
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

/**
 * Launch a dual-homed Ubuntu NAT gateway for a VPC:
 * - net0: VPC Multus, pinned to the VPC gateway IP (no default route)
 * - net1: public Multus from cluster ipPools (default route + MASQUERADE)
 * Stamps the VPC gateway annotation when missing and records the gateway VM.
 */
export async function createNatGateway(
  input: CreateNatGatewayRequest,
): Promise<VmSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.vpcName?.trim()) throw new Error("vpcName is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!DNS1123_LABEL.test(input.name.trim()) || input.name.trim().length > 63) {
    throw new Error(
      "name must be a DNS-1123 label (lowercase alphanumeric and hyphens, ≤63 chars)",
    );
  }
  if (!input.publicMultusNetwork?.trim()) {
    throw new Error("publicMultusNetwork is required");
  }
  if (!input.sshPublicKey?.trim()) throw new Error("sshPublicKey is required");
  if (!input.diskSize?.trim()) throw new Error("diskSize is required");
  if (!input.image?.name?.trim()) throw new Error("image is required");
  if (!input.instanceType && !(input.cpuCores && input.memory)) {
    throw new Error("Provide instanceType or both cpuCores and memory");
  }

  await assertVmNamespaceAllowed(input.cluster, input.namespace);

  // Public egress Multus (e.g. external) is often missing in new namespaces.
  await ensureStaticMultusNads(input.cluster, input.namespace, [
    input.publicMultusNetwork.trim(),
  ]);

  const vpc = await getVpc(input.cluster, input.namespace, input.vpcName);
  if (!vpc.cidr?.trim()) {
    throw new Error(
      "NAT gateway requires private IPAM on the VPC (set a CIDR first)",
    );
  }
  if (vpc.natGateway) {
    throw new Error(
      `VPC already has a NAT gateway VM: ${vpc.natGateway.namespace}/${vpc.natGateway.name}`,
    );
  }

  const publicNet = input.publicMultusNetwork.trim();
  if (multusRefMatches(publicNet, input.namespace, input.vpcName)) {
    throw new Error("public Multus network must not be the VPC itself");
  }
  const publicPool = findIpPoolForMultus(input.cluster, publicNet);
  if (!publicPool) {
    throw new Error(
      `No static ipPools entry for Multus network "${publicNet}" on cluster ${input.cluster}`,
    );
  }
  if (!publicPool.gateway?.trim()) {
    throw new Error(
      `Public pool "${publicPool.id}" has no gateway — NAT gateway needs a default route on the egress NIC`,
    );
  }

  const privateGateway =
    vpc.gateway?.trim() || defaultGatewayAddress(vpc.cidr);

  // Validate gateway is inside the VPC CIDR
  validateVpcIpamFields({
    cidr: vpc.cidr,
    gateway: privateGateway,
    dns: vpc.dns,
  });

  const multusNames = [input.vpcName, publicNet];
  const privateAlloc = await allocateIpv4ForMultus(
    input.cluster,
    input.vpcName,
    input.namespace,
    {
      preferredAddress: privateGateway,
      claimGateway: true,
      // Private NIC is the gateway itself — no default via self
      gatewayOverride: null,
    },
  );
  if (!privateAlloc) {
    throw new Error(
      `Could not allocate private IP on VPC ${input.namespace}/${input.vpcName}`,
    );
  }

  const publicAlloc = await allocateIpv4ForMultus(
    input.cluster,
    publicNet,
    input.namespace,
    { extraUsed: [privateAlloc.address] },
  );
  if (!publicAlloc) {
    throw new Error(
      `Could not allocate public IP on Multus network "${publicNet}"`,
    );
  }

  const allocations = bindAllocationsToNetworks(multusNames, [
    privateAlloc,
    publicAlloc,
  ]);
  const privateBound = allocations[0];
  const publicBound = allocations[1];
  if (!privateBound?.macAddress || !publicBound?.macAddress) {
    throw new Error("NAT gateway requires MACs on both interfaces");
  }

  const preference = await getImagePreference(
    input.cluster,
    input.image.namespace || "vm-images",
    input.image.name,
  );

  const createVmInput = {
    cluster: input.cluster,
    namespace: input.namespace,
    name: input.name.trim(),
    instanceType: input.instanceType,
    cpuCores: input.cpuCores,
    memory: input.memory,
    preference,
    diskSize: input.diskSize,
    storageClass: input.storageClass,
    image: input.image,
    networks: multusNames.map((multusNetworkName) => ({ multusNetworkName })),
    sshPublicKey: input.sshPublicKey,
    start: input.start !== false,
  };

  const userData = buildNatGatewayUserData({
    sshPublicKey: input.sshPublicKey,
    privateMac: privateBound.macAddress,
    publicMac: publicBound.macAddress,
  });

  const vmName = input.name.trim();
  const secretName = cloudInitUserDataSecretName(vmName);
  const roleLabels = {
    [KMC_LABEL_ROLE]: KMC_ROLE_NAT_GATEWAY,
    [KMC_LABEL_VPC]: input.vpcName,
  };

  const body = buildVirtualMachineManifest(createVmInput, allocations, {
    labels: roleLabels,
    // Inline userData exceeds KubeVirt's 2048-byte admission limit for NAT scripts.
    userDataSecretName: secretName,
  });

  const { custom, core } = getClusterClients(input.cluster);

  // Secret key must be `userdata` for cloudInitNoCloud.secretRef (KubeVirt).
  try {
    await core.createNamespacedSecret({
      namespace: input.namespace,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: secretName,
          namespace: input.namespace,
          labels: {
            [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
            ...roleLabels,
            "kubevirt.io/vm": vmName,
          },
        },
        type: "Opaque",
        stringData: {
          userdata: userData,
        },
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to create cloud-init Secret ${input.namespace}/${secretName}: ${formatError(err)}`,
      { cause: err },
    );
  }

  try {
    const created = (await custom.createNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace: input.namespace,
      plural: "virtualmachines",
      body,
    })) as KubeVm;

    // GC the Secret with the VM when the VM is deleted.
    const uid = created.metadata?.uid;
    if (uid) {
      try {
        const secret = await core.readNamespacedSecret({
          name: secretName,
          namespace: input.namespace,
        });
        await core.replaceNamespacedSecret({
          name: secretName,
          namespace: input.namespace,
          body: {
            ...secret,
            metadata: {
              ...secret.metadata,
              ownerReferences: [
                {
                  apiVersion: "kubevirt.io/v1",
                  kind: "VirtualMachine",
                  name: vmName,
                  uid,
                  controller: true,
                  blockOwnerDeletion: true,
                },
              ],
            },
          },
        });
      } catch (ownerErr) {
        console.error(
          "Failed to set ownerReference on cloud-init Secret:",
          formatError(ownerErr),
        );
      }
    }

    // Stamp VPC gateway + nat-gateway pointer (best-effort after VM exists)
    try {
      await patchVpcNatGatewayMetadata(input.cluster, input.namespace, input.vpcName, {
        gateway: privateGateway,
        natGatewayVm: vmName,
        dns: vpc.dns,
        cidr: vpc.cidr,
        description: vpc.description,
      });
    } catch (metaErr) {
      console.error("Failed to update VPC NAT metadata:", formatError(metaErr));
    }

    return {
      cluster: input.cluster,
      namespace: created.metadata?.namespace ?? input.namespace,
      name: created.metadata?.name ?? vmName,
      status: created.status?.printableStatus ?? "Provisioning",
      ready: created.status?.ready === true,
      running: true,
      allocatedIpv4: `${privateBound.cidrHost},${publicBound.cidrHost}`,
      age: created.metadata?.creationTimestamp ?? new Date().toISOString(),
    };
  } catch (err) {
    // Roll back the Secret if the VM was not created.
    try {
      await core.deleteNamespacedSecret({
        name: secretName,
        namespace: input.namespace,
      });
    } catch {
      /* ignore cleanup errors */
    }
    throw new Error(formatError(err), { cause: err });
  }
}

async function patchVpcNatGatewayMetadata(
  cluster: ClusterId,
  namespace: string,
  name: string,
  opts: {
    gateway: string;
    natGatewayVm: string;
    cidr: string;
    dns?: string[];
    description?: string;
  },
): Promise<void> {
  const { custom } = getClusterClients(cluster);
  const existing = (await custom.getNamespacedCustomObject({
    group: "k8s.cni.cncf.io",
    version: "v1",
    namespace,
    plural: "network-attachment-definitions",
    name,
  })) as KubeNad;

  const annotations = applyVpcMutableAnnotations(
    existing.metadata?.annotations ?? {},
    {
      description: opts.description,
      cidr: opts.cidr,
      gateway: opts.gateway,
      dns: opts.dns,
    },
  );
  annotations[KMC_ANN_NAT_GATEWAY] = opts.natGatewayVm;

  const body = {
    ...existing,
    metadata: {
      ...existing.metadata,
      annotations,
    },
  };

  await custom.replaceNamespacedCustomObject({
    group: "k8s.cni.cncf.io",
    version: "v1",
    namespace,
    plural: "network-attachment-definitions",
    name,
    body,
  });
}

export { listVlanPools, clusterHasVlanPools };
export type { IpPoolUsage };
