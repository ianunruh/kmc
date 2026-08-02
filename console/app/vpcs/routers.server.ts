import { formatError } from "~/lib/errors";
import type {
  AttachRouterVpcRequest,
  ClusterId,
  CreateRouterRequest,
  DetachRouterVpcRequest,
  FloatingIpAssociation,
  PortForwardAssociation,
  RouterAgentStatus,
  RouterDetail,
  RouterInterfaceInfo,
  RouterLease,
  RouterSummary,
} from "~/lib/types";
import { assertVmNamespaceAllowed } from "~/lib/k8s/catalog.server";
import { getConfiguredContexts } from "~/lib/k8s/clients.server";
import { toResourceYaml } from "~/lib/k8s/yaml.server";
import { DNS1123_LABEL, formatAge } from "~/lib/format";
import { KMC_MAX_MULTUS_ATTACHMENTS } from "~/lib/k8s/constants";
import {
  createNamespacedCustomObject,
  deleteNamespacedCustomObject,
  getNamespacedCustomObject,
  isNotFoundError,
  KMC_API,
  kmcManagedLabels,
  listClusterCustomObjects,
  listNamespacedCustomObjects,
  PLURAL_FLOATING_IPS,
  PLURAL_IP_ADDRESSES,
  PLURAL_PORT_FORWARDS,
  PLURAL_ROUTERS,
  PLURAL_VPCS,
  replaceNamespacedCustomObject,
  type FloatingIpCr,
  type IpAddressCr,
  type PortForwardCr,
  type RouterCr,
  type RouterExternalSpec,
  type VpcCr,
} from "~/lib/k8s/networking-cr.server";

export function routerPolicyConfigMapName(routerName: string): string {
  return `kmc-router-${routerName}`;
}

export function defaultRouterDomain(vpcName: string): string {
  return `${vpcName}.vpc.local`;
}

function agentStatusFromRouter(r: RouterCr): RouterAgentStatus | undefined {
  const raw = r.status?.agent?.status?.trim();
  if (!raw) return undefined;
  if (
    raw === "Ready" ||
    raw === "Error" ||
    raw === "Pending" ||
    raw === "Unknown" ||
    raw === "Stale"
  ) {
    return raw;
  }
  return "Unknown";
}

function mapRouterSummary(cluster: ClusterId, cr: RouterCr): RouterSummary {
  const ifaces =
    cr.status?.interfaces ??
    cr.spec?.vpcs?.map((v) => ({ vpc: v.name })) ??
    [];
  return {
    cluster,
    namespace: cr.metadata?.namespace ?? "default",
    name: cr.metadata?.name ?? "unknown",
    vpcNames: ifaces
      .map((i) => i.vpc)
      .filter((v): v is string => Boolean(v?.trim())),
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

function mapInterfaces(cr: RouterCr): RouterInterfaceInfo[] {
  const statusIfaces = cr.status?.interfaces ?? [];
  if (statusIfaces.length > 0) {
    return statusIfaces.map((i) => ({
      vpc: i.vpc ?? "",
      cidr: i.cidr ?? "",
      gateway: i.gateway ?? "",
      domain: i.domain ?? (i.vpc ? defaultRouterDomain(i.vpc) : ""),
      mac: i.mac,
    }));
  }
  return (cr.spec?.vpcs ?? []).map((v) => ({
    vpc: v.name,
    cidr: "",
    gateway: v.gateway ?? "",
    domain: defaultRouterDomain(v.name),
  }));
}

function mapFloatingFromCr(cr: FloatingIpCr): FloatingIpAssociation {
  const publicAddr =
    cr.status?.address?.trim() || cr.spec?.address?.trim() || "";
  const privateAddr = cr.spec?.privateAddress?.trim() || undefined;
  return {
    id: cr.metadata?.name ?? publicAddr,
    public: publicAddr,
    prefix: cr.status?.prefixLength ?? 32,
    private: privateAddr,
    targetVm: cr.spec?.targetVM?.name,
    state: privateAddr ? "associated" : "held",
  };
}

function mapPortForwardFromCr(cr: PortForwardCr): PortForwardAssociation {
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
    vpc: cr.spec?.vpcRef?.name,
  };
}

async function loadVpcCr(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<VpcCr> {
  try {
    return await getNamespacedCustomObject<VpcCr>(
      cluster,
      namespace,
      PLURAL_VPCS,
      name,
    );
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(`VPC ${namespace}/${name} not found`);
    }
    throw new Error(formatError(err), { cause: err });
  }
}

export async function listRouters(clusterFilter?: string): Promise<{
  items: RouterSummary[];
  clusters: Array<{ id: string; reachable: boolean; error?: string }>;
}> {
  const contexts = getConfiguredContexts();
  const wanted = clusterFilter?.trim()
    ? contexts.filter((c) => c === clusterFilter.trim())
    : contexts;

  const clusters: Array<{ id: string; reachable: boolean; error?: string }> =
    wanted.map((id) => ({ id, reachable: true }));
  const items: RouterSummary[] = [];

  await Promise.all(
    wanted.map(async (clusterId) => {
      const cluster = clusters.find((c) => c.id === clusterId);
      try {
        const crs = await listClusterCustomObjects<RouterCr>(
          clusterId,
          PLURAL_ROUTERS,
        );
        for (const cr of crs) {
          items.push(mapRouterSummary(clusterId, cr));
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

  return { items, clusters };
}

export async function getRouter(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<RouterDetail> {
  let cr: RouterCr;
  try {
    cr = await getNamespacedCustomObject<RouterCr>(
      cluster,
      namespace,
      PLURAL_ROUTERS,
      name,
    );
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Response("Router not found", { status: 404 });
    }
    throw new Error(formatError(err), { cause: err });
  }

  const summary = mapRouterSummary(cluster, cr);
  const interfaces = mapInterfaces(cr);
  const attached = new Set(interfaces.map((i) => i.vpc).filter(Boolean));

  const [ipAddrs, fips, pfs] = await Promise.all([
    listNamespacedCustomObjects<IpAddressCr>(
      cluster,
      namespace,
      PLURAL_IP_ADDRESSES,
    ).catch(() => [] as IpAddressCr[]),
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

  const leases: RouterLease[] = [];
  for (const ip of ipAddrs) {
    if (ip.spec?.poolRef?.kind !== "VPC") continue;
    const vpc = ip.spec.poolRef.name?.trim() ?? "";
    if (!attached.has(vpc)) continue;
    const mac = ip.spec.interface?.mac?.trim();
    if (!mac) continue;
    if (ip.spec.claimRef?.kind === "Router") continue;
    const hostname =
      ip.spec.interface?.hostname?.trim() ||
      (ip.spec.claimRef?.kind === "VirtualMachine"
        ? ip.spec.claimRef.name
        : undefined) ||
      "host";
    leases.push({
      vpc,
      mac: mac.toLowerCase(),
      ip: ip.spec.address?.trim() ?? "",
      hostname,
      vm:
        ip.spec.claimRef?.kind === "VirtualMachine"
          ? ip.spec.claimRef.name
          : undefined,
    });
  }

  const floatingIps = fips
    .filter((f) => {
      const vpc = f.spec?.vpcRef?.name;
      if (!vpc || !attached.has(vpc)) return false;
      if (f.spec?.routerRef?.name && f.spec.routerRef.name !== name) return false;
      return true;
    })
    .map(mapFloatingFromCr);

  const portForwards = pfs
    .filter((pf) => {
      const vpc = pf.spec?.vpcRef?.name;
      if (!vpc || !attached.has(vpc)) return false;
      if (pf.spec?.routerRef?.name && pf.spec.routerRef.name !== name) {
        return false;
      }
      return true;
    })
    .map(mapPortForwardFromCr);

  const agent = cr.status?.agent;
  return {
    ...summary,
    uid: cr.metadata?.uid,
    labels: cr.metadata?.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(cr.metadata?.annotations ?? {}).filter(
        ([k]) => !k.startsWith("kubectl.kubernetes.io/"),
      ),
    ),
    policyConfigMap:
      cr.status?.policyConfigMap || routerPolicyConfigMapName(name),
    interfaces,
    external: cr.status?.external?.multusNetwork
      ? {
          multusNetwork: cr.status.external.multusNetwork,
          primaryCidr: cr.status.external.primaryCidr,
          gateway: cr.status.external.gateway,
          snat: cr.status.external.snat,
        }
      : cr.spec?.external?.multusNetwork
        ? {
            multusNetwork: cr.spec.external.multusNetwork,
            primaryCidr: undefined,
            gateway: undefined,
            snat: cr.spec.external.snat !== false,
          }
        : undefined,
    leases,
    floatingIps,
    portForwards,
    agentStatus: agentStatusFromRouter(cr),
    agentObservedGeneration: agent?.observedGeneration,
    agentLastError: agent?.lastError,
    agentAppliedAt: agent?.appliedAt,
    agentHeartbeatAt: agent?.heartbeatAt,
    agentVersion: agent?.version,
    vmName: cr.status?.vmName || name,
    vmStatus: cr.status?.vmStatus,
    vmReady: cr.status?.vmReady,
    vmMissing: cr.status?.vmMissing,
  };
}

export async function getRouterYaml(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<string> {
  const obj = await getNamespacedCustomObject(
    cluster,
    namespace,
    PLURAL_ROUTERS,
    name,
  );
  return toResourceYaml(obj);
}

/**
 * Create a Router CR — controller owns appliance, policy, gateway claims.
 */
export async function createRouter(
  input: CreateRouterRequest,
): Promise<RouterSummary> {
  if (!input.cluster?.trim()) throw new Error("cluster is required");
  if (!input.namespace?.trim()) throw new Error("namespace is required");
  if (!input.name?.trim()) throw new Error("name is required");
  if (!DNS1123_LABEL.test(input.name.trim()) || input.name.trim().length > 63) {
    throw new Error(
      "name must be a DNS-1123 label (lowercase alphanumeric and hyphens, ≤63 chars)",
    );
  }
  if (!input.sshPublicKey?.trim()) throw new Error("sshPublicKey is required");
  if (!input.diskSize?.trim()) throw new Error("diskSize is required");
  if (!input.image?.name?.trim()) throw new Error("image is required");
  if (!input.instanceType && !(input.cpuCores && input.memory)) {
    throw new Error("Provide instanceType or both cpuCores and memory");
  }

  const vpcNames = [
    ...new Set((input.vpcNames ?? []).map((n) => n.trim()).filter(Boolean)),
  ];
  if (vpcNames.length === 0) {
    throw new Error("Select at least one VPC to attach");
  }
  if (vpcNames.length + (input.externalMultusNetwork?.trim() ? 1 : 0) >
    KMC_MAX_MULTUS_ATTACHMENTS) {
    throw new Error(
      `At most ${KMC_MAX_MULTUS_ATTACHMENTS} Multus attachments (VPCs + optional external)`,
    );
  }

  await assertVmNamespaceAllowed(input.cluster, input.namespace);

  for (const vpcName of vpcNames) {
    const vpc = await loadVpcCr(input.cluster, input.namespace, vpcName);
    if (!vpc.spec?.cidr?.trim()) {
      throw new Error(
        `VPC ${vpcName} requires private IPAM (CIDR) before attaching a router`,
      );
    }
    const existingRouter = vpc.status?.routerRef?.name?.trim();
    if (existingRouter) {
      throw new Error(
        `VPC ${vpcName} is already attached to router ${existingRouter}`,
      );
    }
  }

  const external: RouterExternalSpec | undefined = input.externalMultusNetwork
    ?.trim()
    ? {
        multusNetwork: input.externalMultusNetwork.trim(),
        snat: true,
      }
    : undefined;

  const body: RouterCr = {
    apiVersion: KMC_API,
    kind: "Router",
    metadata: {
      name: input.name.trim(),
      namespace: input.namespace.trim(),
      labels: kmcManagedLabels(),
    },
    spec: {
      vpcs: vpcNames.map((name) => ({ name })),
      ...(external ? { external } : {}),
      appliance: {
        image: {
          kind: "pvc",
          namespace: input.image.namespace.trim() || "vm-images",
          name: input.image.name.trim(),
        },
        ...(input.instanceType?.trim()
          ? { instanceType: input.instanceType.trim() }
          : {
              cpuCores: input.cpuCores,
              memory: input.memory?.trim(),
            }),
        diskSize: input.diskSize.trim(),
        ...(input.storageClass?.trim()
          ? { storageClass: input.storageClass.trim() }
          : {}),
        sshPublicKeys: [input.sshPublicKey.trim()],
        runStrategy: input.start === false ? "Halted" : "Always",
      },
    },
  };

  try {
    const created = await createNamespacedCustomObject<RouterCr>(
      input.cluster,
      input.namespace,
      PLURAL_ROUTERS,
      body,
    );
    return mapRouterSummary(input.cluster, created);
  } catch (err) {
    throw new Error(formatError(err), { cause: err });
  }
}

export async function deleteRouter(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  await deleteNamespacedCustomObject(cluster, namespace, PLURAL_ROUTERS, name);
}

export type SetRouterExternalRequest = {
  cluster: ClusterId;
  namespace: string;
  routerName: string;
  publicMultusNetwork: string;
  /** Kept for UI compatibility; appliance SSH is owned by the controller. */
  sshPublicKey?: string;
};

export async function setRouterExternalGateway(
  input: SetRouterExternalRequest,
): Promise<void> {
  const publicNet = input.publicMultusNetwork.trim();
  if (!publicNet) throw new Error("public Multus network is required");

  let existing: RouterCr;
  try {
    existing = await getNamespacedCustomObject<RouterCr>(
      input.cluster,
      input.namespace,
      PLURAL_ROUTERS,
      input.routerName,
    );
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(
        `Router ${input.namespace}/${input.routerName} not found`,
      );
    }
    throw err;
  }

  const vpcCount = existing.spec?.vpcs?.length ?? 0;
  if (vpcCount + 1 > KMC_MAX_MULTUS_ATTACHMENTS) {
    throw new Error(
      `Cannot add external gateway: would exceed ${KMC_MAX_MULTUS_ATTACHMENTS} Multus attachments`,
    );
  }

  const next: RouterCr = {
    ...existing,
    spec: {
      ...existing.spec,
      vpcs: existing.spec?.vpcs ?? [],
      appliance: existing.spec?.appliance,
      external: {
        multusNetwork: publicNet,
        snat: true,
      },
    },
  };

  await replaceNamespacedCustomObject(
    input.cluster,
    input.namespace,
    PLURAL_ROUTERS,
    input.routerName,
    next,
  );
}

/**
 * Controller owns the appliance; recreate is not supported from the console.
 * Surface a clear error if the UI still offers the action.
 */
export type RecreateRouterVmRequest = {
  cluster: ClusterId;
  namespace: string;
  routerName: string;
  sshPublicKey: string;
  diskSize: string;
  storageClass?: string;
  image: { kind: "pvc"; namespace: string; name: string };
  instanceType?: string;
  cpuCores?: number;
  memory?: string;
};

export async function recreateRouterVm(
  _input: RecreateRouterVmRequest,
): Promise<void> {
  throw new Error(
    "Router appliance is managed by the kmc-controller. Delete and recreate the Router CR, or fix the appliance VM in-cluster.",
  );
}

export async function attachRouterVpc(
  input: AttachRouterVpcRequest,
): Promise<{ restarted: boolean }> {
  const vpcName = input.vpcName.trim();
  if (!vpcName) throw new Error("vpcName is required");

  const vpc = await loadVpcCr(input.cluster, input.namespace, vpcName);
  if (!vpc.spec?.cidr?.trim()) {
    throw new Error(
      `VPC ${vpcName} requires private IPAM (CIDR) before attaching a router`,
    );
  }
  const existingRouter = vpc.status?.routerRef?.name?.trim();
  if (existingRouter && existingRouter !== input.routerName) {
    throw new Error(
      `VPC ${vpcName} is already attached to router ${existingRouter}`,
    );
  }

  let router: RouterCr;
  try {
    router = await getNamespacedCustomObject<RouterCr>(
      input.cluster,
      input.namespace,
      PLURAL_ROUTERS,
      input.routerName,
    );
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(
        `Router ${input.namespace}/${input.routerName} not found`,
      );
    }
    throw err;
  }

  const vpcs = [...(router.spec?.vpcs ?? [])];
  if (vpcs.some((v) => v.name === vpcName)) {
    return { restarted: false };
  }

  const hasExternal = Boolean(router.spec?.external?.multusNetwork?.trim());
  if (vpcs.length + (hasExternal ? 1 : 0) + 1 > KMC_MAX_MULTUS_ATTACHMENTS) {
    throw new Error(
      `Cannot attach VPC: would exceed ${KMC_MAX_MULTUS_ATTACHMENTS} Multus attachments`,
    );
  }

  const newCidr = vpc.spec.cidr.trim();
  for (const v of vpcs) {
    try {
      const other = await loadVpcCr(input.cluster, input.namespace, v.name);
      if (other.spec?.cidr?.trim() === newCidr) {
        throw new Error(
          `CIDR ${newCidr} already used by VPC ${v.name} on this router`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("already used")) throw err;
    }
  }

  vpcs.push({ name: vpcName });
  const next: RouterCr = {
    ...router,
    spec: {
      ...router.spec,
      vpcs,
      appliance: router.spec?.appliance,
    },
  };

  await replaceNamespacedCustomObject(
    input.cluster,
    input.namespace,
    PLURAL_ROUTERS,
    input.routerName,
    next,
  );
  // Controller may require appliance restart; LiveUpdate handles many cases.
  return { restarted: false };
}

export async function detachRouterVpc(
  input: DetachRouterVpcRequest,
): Promise<{ restarted: boolean }> {
  const vpcName = input.vpcName.trim();
  if (!vpcName) throw new Error("vpcName is required");

  let router: RouterCr;
  try {
    router = await getNamespacedCustomObject<RouterCr>(
      input.cluster,
      input.namespace,
      PLURAL_ROUTERS,
      input.routerName,
    );
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(
        `Router ${input.namespace}/${input.routerName} not found`,
      );
    }
    throw err;
  }

  const vpcs = router.spec?.vpcs ?? [];
  if (!vpcs.some((v) => v.name === vpcName)) {
    throw new Error(`VPC ${vpcName} is not attached to this router`);
  }
  if (vpcs.length <= 1) {
    throw new Error(
      "Cannot detach the last VPC — delete the router instead",
    );
  }

  if (!input.force) {
    const [ipAddrs, fips] = await Promise.all([
      listNamespacedCustomObjects<IpAddressCr>(
        input.cluster,
        input.namespace,
        PLURAL_IP_ADDRESSES,
      ),
      listNamespacedCustomObjects<FloatingIpCr>(
        input.cluster,
        input.namespace,
        PLURAL_FLOATING_IPS,
      ),
    ]);
    const guestLeases = ipAddrs.filter(
      (ip) =>
        ip.spec?.poolRef?.kind === "VPC" &&
        ip.spec.poolRef.name === vpcName &&
        ip.spec.claimRef?.kind === "VirtualMachine" &&
        ip.spec.interface?.mac,
    );
    const activeFips = fips.filter(
      (f) =>
        f.spec?.vpcRef?.name === vpcName && f.spec.privateAddress?.trim(),
    );
    if (guestLeases.length > 0 || activeFips.length > 0) {
      throw new Error(
        `VPC ${vpcName} still has ${guestLeases.length} guest lease(s) and ${activeFips.length} associated floating IP(s). Force detach to continue.`,
      );
    }
  }

  const next: RouterCr = {
    ...router,
    spec: {
      ...router.spec,
      vpcs: vpcs.filter((v) => v.name !== vpcName),
      appliance: router.spec?.appliance,
    },
  };

  await replaceNamespacedCustomObject(
    input.cluster,
    input.namespace,
    PLURAL_ROUTERS,
    input.routerName,
    next,
  );
  return { restarted: false };
}

export async function listRoutersForVpcAttach(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
): Promise<
  Array<{
    name: string;
    vpcNames: string[];
    hasExternal: boolean;
    agentStatus?: string;
    multusCount: number;
  }>
> {
  const vpc = await loadVpcCr(cluster, namespace, vpcName);
  if (vpc.status?.routerRef?.name?.trim()) return [];
  const vpcCidr = vpc.spec?.cidr?.trim();
  if (!vpcCidr) return [];

  const routers = await listNamespacedCustomObjects<RouterCr>(
    cluster,
    namespace,
    PLURAL_ROUTERS,
  );
  const out: Array<{
    name: string;
    vpcNames: string[];
    hasExternal: boolean;
    agentStatus?: string;
    multusCount: number;
  }> = [];

  for (const r of routers) {
    const name = r.metadata?.name ?? "";
    if (!name) continue;
    const vpcs = r.spec?.vpcs ?? [];
    if (vpcs.some((v) => v.name === vpcName)) continue;

    const hasExternal = Boolean(r.spec?.external?.multusNetwork?.trim());
    const multusCount = vpcs.length + (hasExternal ? 1 : 0);
    if (multusCount + 1 > KMC_MAX_MULTUS_ATTACHMENTS) continue;

    // Check CIDR overlap via VPC specs
    let overlap = false;
    for (const v of vpcs) {
      try {
        const other = await loadVpcCr(cluster, namespace, v.name);
        if (other.spec?.cidr?.trim() === vpcCidr) {
          overlap = true;
          break;
        }
      } catch {
        /* ignore missing */
      }
    }
    if (overlap) continue;

    out.push({
      name,
      vpcNames: vpcs.map((v) => v.name),
      hasExternal,
      agentStatus: agentStatusFromRouter(r),
      multusCount,
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function listRouterAttachableVpcs(
  cluster: ClusterId,
  namespace: string,
): Promise<
  Array<{
    name: string;
    cidr?: string;
    gateway?: string;
    attachedRouter?: string;
  }>
> {
  const items = await listNamespacedCustomObjects<VpcCr>(
    cluster,
    namespace,
    PLURAL_VPCS,
  );
  const out = items.map((vpc) => ({
    name: vpc.metadata?.name ?? "",
    cidr: vpc.spec?.cidr,
    gateway: vpc.spec?.gateway,
    attachedRouter: vpc.status?.routerRef?.name?.trim() || undefined,
  }));
  return out
    .filter((v) => v.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}
