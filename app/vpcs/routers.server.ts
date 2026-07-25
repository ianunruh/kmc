import { formatError } from "~/lib/errors";
import type {
  AttachRouterVpcRequest,
  ClusterId,
  CreateRouterRequest,
  DetachRouterVpcRequest,
  RouterDetail,
  RouterSummary,
  VmSummary,
} from "~/lib/types";
import {
  KMC_ANN_CIDR,
  KMC_ANN_DNS,
  KMC_ANN_GATEWAY,
  KMC_ANN_ROUTER,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_ROLE,
  KMC_LABEL_ROUTER,
  KMC_MANAGED_BY,
  KMC_MAX_MULTUS_ATTACHMENTS,
  KMC_RESOURCE_VPC,
  KMC_ROLE_ROUTER,
  KMC_VPC_LABEL_SELECTOR,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import { assertVmNamespaceAllowed, getImagePreference } from "~/lib/k8s/catalog.server";
import { getClusterClients, getConfiguredContexts } from "~/lib/k8s/clients.server";
import { toResourceYaml } from "~/lib/k8s/yaml.server";
import { DNS1123_LABEL } from "~/lib/format";
import {
  allocateIpv4ForMultus,
  findIpPoolForMultus,
  generateLocalMacAddress,
  type AllocatedIp,
} from "~/lib/ipam/pools.server";
import {
  bindAllocationsToNetworks,
  buildRouterUserData,
  buildVirtualMachineManifest,
  cloudInitUserDataSecretName,
  POD_NETWORK_NAME,
} from "~/vms/template.server";
import {
  ensureRootDataVolumeFromImage,
  restartVm,
} from "~/vms/vms.server";
import { getPlatformConsolePublicKey } from "~/vms/console-ssh-key.server";
import {
  containsIpv4,
  formatIpv4,
  parseCidr,
  parseIpv4,
  usableHostRange,
} from "~/lib/ipam/cidr";
import { ensureStaticMultusNads } from "~/lib/k8s/static-nads.server";
import {
  agentInfoFromRouterAnnotations,
  defaultRouterDomain,
  deleteRouterControlPlane,
  emptyRouterPolicyDoc,
  ensureRouterControlPlane,
  floatingIpsFromRouterDoc,
  portForwardsFromRouterDoc,
  getRouterPolicyConfigMap,
  interfacesFromDoc,
  leasesFromDoc,
  listRouterPolicyConfigMaps,
  mutateRouterPolicyDoc,
  replaceRouterPolicyDoc,
  routerPolicyConfigMapName,
  summaryFromRouterPolicy,
  syncRouterAgentScript,
  syncRouterFloatingAnnotation,
  syncRouterVmIpamAnnotationsFromPolicy,
  type RouterPolicyDoc,
} from "~/vpcs/router-policy.server";

/** First usable host in a CIDR (same rule as VPC default gateway). */
function defaultGatewayAddress(cidr: string): string {
  const range = usableHostRange(parseCidr(cidr));
  return formatIpv4(range.start);
}

function validateGatewayInCidr(cidr: string, gateway: string): void {
  const parsed = parseCidr(cidr);
  parseIpv4(gateway);
  if (!containsIpv4(parsed, gateway)) {
    throw new Error(`gateway ${gateway} is outside ${parsed.cidr}`);
  }
}

type VpcAttachInfo = {
  name: string;
  cidr: string;
  gateway?: string;
  dns?: string[];
  routerAnn?: string;
};

async function loadVpcAttachInfo(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
): Promise<VpcAttachInfo> {
  const { custom } = getClusterClients(cluster);
  let nad: KubeNad;
  try {
    nad = (await custom.getNamespacedCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      namespace,
      plural: "network-attachment-definitions",
      name: vpcName,
    })) as KubeNad;
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(`VPC ${namespace}/${vpcName} not found`);
    }
    throw new Error(formatError(err), { cause: err });
  }
  const ann = nad.metadata?.annotations ?? {};
  const cidr = ann[KMC_ANN_CIDR]?.trim();
  if (!cidr) {
    throw new Error(
      `VPC ${vpcName} requires private IPAM (CIDR) before attaching a router`,
    );
  }
  const dns = (ann[KMC_ANN_DNS] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: vpcName,
    cidr,
    gateway: ann[KMC_ANN_GATEWAY]?.trim() || undefined,
    dns,
    routerAnn: ann[KMC_ANN_ROUTER]?.trim() || undefined,
  };
}

type KubeVm = {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  status?: {
    printableStatus?: string;
    ready?: boolean;
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
    }>;
  };
};

type KubeNad = {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
};

function isNotFound(err: unknown): boolean {
  const message = formatError(err).toLowerCase();
  return message.includes("404") || message.includes("not found");
}

export async function listRouters(clusterFilter?: string): Promise<{
  items: RouterSummary[];
  clusters: Array<{ id: string; reachable: boolean; error?: string }>;
}> {
  const contexts = getConfiguredContexts();
  const wanted = clusterFilter?.trim()
    ? contexts.filter((c) => c === clusterFilter.trim())
    : contexts;

  const clusters: Array<{ id: string; reachable: boolean; error?: string }> = wanted.map(
    (id) => ({ id, reachable: true }),
  );
  const items: RouterSummary[] = [];

  await Promise.all(
    wanted.map(async (clusterId) => {
      const cluster = clusters.find((c) => c.id === clusterId);
      try {
        const policies = await listRouterPolicyConfigMaps(clusterId);
        for (const p of policies) {
          items.push(
            summaryFromRouterPolicy(
              clusterId,
              p.namespace,
              p.routerName,
              p.doc,
              p.annotations,
              p.creationTimestamp,
            ),
          );
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
  const policy = await getRouterPolicyConfigMap(cluster, namespace, name);
  if (!policy) {
    throw new Response("Router not found", { status: 404 });
  }

  await syncRouterAgentScript(cluster, namespace, name).catch(() => false);

  const refreshed = await getRouterPolicyConfigMap(cluster, namespace, name);
  const doc = refreshed?.doc ?? policy.doc;
  const annotations = refreshed?.annotations ?? policy.annotations;
  const agent = agentInfoFromRouterAnnotations(annotations);
  const summary = summaryFromRouterPolicy(
    cluster,
    namespace,
    name,
    doc,
    annotations,
    refreshed?.creationTimestamp ?? policy.creationTimestamp,
  );

  let vmStatus: string | undefined;
  let vmReady: boolean | undefined;
  let vmMissing = false;
  let vmRestartRequired = false;
  let vmRestartRequiredMessage: string | undefined;
  try {
    const { custom } = getClusterClients(cluster);
    const vm = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name,
    })) as KubeVm;
    vmStatus = vm.status?.printableStatus;
    vmReady = vm.status?.ready === true;
    const restartCond = (vm.status?.conditions ?? []).find(
      (c) => c.type === "RestartRequired" && c.status === "True",
    );
    if (restartCond) {
      vmRestartRequired = true;
      const msg = restartCond.message?.trim() || restartCond.reason?.trim();
      vmRestartRequiredMessage = msg || undefined;
    }
  } catch (err) {
    /* Policy survives appliance delete — surface missing VM for recreate UI */
    if (isNotFound(err)) {
      vmMissing = true;
    }
  }

  return {
    ...summary,
    uid: undefined,
    labels: refreshed?.labels ?? policy.labels,
    annotations: Object.fromEntries(
      Object.entries(annotations).filter(
        ([k]) => !k.startsWith("kubectl.kubernetes.io/"),
      ),
    ),
    policyConfigMap: routerPolicyConfigMapName(name),
    interfaces: interfacesFromDoc(doc),
    external: doc?.external?.multusNetwork
      ? {
          multusNetwork: doc.external.multusNetwork,
          primaryCidr: doc.external.primaryCidr,
          gateway: doc.external.gateway,
          snat: doc.external.snat,
        }
      : undefined,
    leases: leasesFromDoc(doc),
    floatingIps: floatingIpsFromRouterDoc(doc),
    portForwards: portForwardsFromRouterDoc(doc),
    ...agent,
    vmName: name,
    vmStatus,
    vmReady,
    vmMissing,
    vmRestartRequired,
    vmRestartRequiredMessage,
  };
}

export async function getRouterYaml(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<string> {
  const policy = await getRouterPolicyConfigMap(cluster, namespace, name);
  if (!policy) {
    throw new Response("Router not found", { status: 404 });
  }
  const { core } = getClusterClients(cluster);
  const cm = await core.readNamespacedConfigMap({
    name: routerPolicyConfigMapName(name),
    namespace,
  });
  return toResourceYaml(cm);
}

/**
 * Launch a shared router VM attached to one or more VPCs (Phase 1: typically one).
 * Claims each VPC gateway IP; DHCP/DNS via in-guest agent.
 */
export async function createRouter(input: CreateRouterRequest): Promise<VmSummary> {
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
    throw new Error("At least one VPC is required");
  }
  const externalNet = input.externalMultusNetwork?.trim() || "";
  const multusBudget = vpcNames.length + (externalNet ? 1 : 0);
  if (multusBudget > KMC_MAX_MULTUS_ATTACHMENTS) {
    throw new Error(
      `At most ${KMC_MAX_MULTUS_ATTACHMENTS} Multus NICs (VPCs + optional external) are supported`,
    );
  }

  await assertVmNamespaceAllowed(input.cluster, input.namespace);

  const existingPolicy = await getRouterPolicyConfigMap(
    input.cluster,
    input.namespace,
    input.name.trim(),
  );
  if (existingPolicy) {
    throw new Error(
      `Router policy already exists for ${input.namespace}/${input.name.trim()}`,
    );
  }

  // Validate VPCs and mutual exclusion with other routers
  const vpcDetails: VpcAttachInfo[] = [];
  for (const vpcName of vpcNames) {
    const vpc = await loadVpcAttachInfo(input.cluster, input.namespace, vpcName);
    if (vpc.routerAnn) {
      throw new Error(`VPC ${vpcName} is already attached to router ${vpc.routerAnn}`);
    }
    vpcDetails.push(vpc);
  }

  // Reject overlapping CIDRs across interfaces
  const cidrs = vpcDetails.map((v) => v.cidr.trim());
  if (new Set(cidrs).size !== cidrs.length) {
    throw new Error("Attached VPCs must have distinct CIDRs");
  }

  const routerName = input.name.trim();
  if (externalNet) {
    await ensureStaticMultusNads(input.cluster, input.namespace, [externalNet]);
    if (!findIpPoolForMultus(input.cluster, externalNet)?.gateway?.trim()) {
      throw new Error(
        `Public pool for "${externalNet}" needs a gateway for the external default route`,
      );
    }
  }

  const multusNames = [...vpcNames];
  const allocations: AllocatedIp[] = [];
  const extraUsed: string[] = [];
  const interfaceSpecs: RouterPolicyDoc["interfaces"] = [];

  for (const vpc of vpcDetails) {
    const privateGateway = vpc.gateway?.trim() || defaultGatewayAddress(vpc.cidr);
    validateGatewayInCidr(vpc.cidr, privateGateway);

    const alloc = await allocateIpv4ForMultus(input.cluster, vpc.name, input.namespace, {
      preferredAddress: privateGateway,
      claimGateway: true,
      gatewayOverride: null,
      extraUsed,
    });
    if (!alloc) {
      throw new Error(
        `Could not allocate gateway IP on VPC ${input.namespace}/${vpc.name}`,
      );
    }
    extraUsed.push(alloc.address);
    allocations.push(alloc);

    interfaceSpecs.push({
      vpc: vpc.name,
      cidr: vpc.cidr.trim(),
      gateway: privateGateway,
      mac: "", // filled after bind
      domain: defaultRouterDomain(vpc.name),
      dhcp: {
        enabled: true,
        leaseTime: "12h",
        authoritative: true,
      },
    });
  }

  let publicAlloc: AllocatedIp | null = null;
  if (externalNet) {
    publicAlloc = await allocateIpv4ForMultus(
      input.cluster,
      externalNet,
      input.namespace,
      { extraUsed },
    );
    if (!publicAlloc) {
      throw new Error(`Could not allocate public IP on Multus "${externalNet}"`);
    }
    multusNames.push(externalNet);
    allocations.push(publicAlloc);
    extraUsed.push(publicAlloc.address);
  }

  // Dual-home (pod first + Multus): always stamp Multus MACs for netplan / agent.
  const bound = bindAllocationsToNetworks(multusNames, allocations, {
    forceMac: true,
  });
  for (let i = 0; i < interfaceSpecs.length; i++) {
    const mac = bound[i]?.macAddress?.trim().toLowerCase();
    if (!mac) {
      throw new Error(`Failed to assign MAC for VPC interface ${interfaceSpecs[i]!.vpc}`);
    }
    interfaceSpecs[i]!.mac = mac;
  }
  const publicBound = externalNet ? bound[interfaceSpecs.length] : undefined;
  if (externalNet && !publicBound?.macAddress) {
    throw new Error("Failed to assign MAC for external gateway NIC");
  }

  const publicPool = externalNet
    ? findIpPoolForMultus(input.cluster, externalNet)
    : undefined;

  const doc: RouterPolicyDoc = {
    ...emptyRouterPolicyDoc(routerName, input.namespace),
    interfaces: interfaceSpecs,
    external:
      externalNet && publicBound && publicPool
        ? {
            multusNetwork: externalNet,
            primaryCidr: publicBound.cidrHost,
            gateway: publicPool.gateway,
            mac: publicBound.macAddress!.toLowerCase(),
            snat: true,
          }
        : null,
    leases: [],
    floatingIPs: [],
    portForwards: [],
  };

  const controlPlane = await ensureRouterControlPlane({
    cluster: input.cluster,
    namespace: input.namespace,
    routerName,
    doc,
  });

  const preference = await getImagePreference(
    input.cluster,
    input.image.namespace || "vm-images",
    input.image.name,
  );

  const createVmInput = {
    cluster: input.cluster,
    namespace: input.namespace,
    name: routerName,
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

  const platformPub = await getPlatformConsolePublicKey();
  const knownMultusMacs = [
    ...interfaceSpecs.map((i) => i.mac),
    ...(publicBound?.macAddress ? [publicBound.macAddress] : []),
  ];
  const userData = buildRouterUserData({
    sshPublicKey: [input.sshPublicKey, ...(platformPub ? [platformPub] : [])],
    knownMultusMacs,
    podCIDRs: controlPlane.podCIDRs,
    serviceCIDRs: controlPlane.serviceCIDRs,
    dnsIP: controlPlane.network.dnsIP,
    namespace: input.namespace,
    policyConfigMap: controlPlane.policyConfigMap,
    apiServer: controlPlane.apiServer,
    caData: controlPlane.caData,
    agentToken: controlPlane.token,
  });

  const secretName = cloudInitUserDataSecretName(routerName);
  const roleLabels = {
    [KMC_LABEL_ROLE]: KMC_ROLE_ROUTER,
    [KMC_LABEL_ROUTER]: routerName,
  };

  const clusterCidrs = [...controlPlane.podCIDRs, ...controlPlane.serviceCIDRs].filter(
    Boolean,
  );
  const body = buildVirtualMachineManifest(createVmInput, bound, {
    labels: roleLabels,
    userDataSecretName: secretName,
    includePodNetwork: true,
    clusterCidrs,
    // Agent owns private Multus L3; netplan is pod + optional external only.
    routerAgentOwnsPrivateL3: true,
    routerExternalAllocation: publicBound ?? null,
  });

  const { custom, core } = getClusterClients(input.cluster);

  try {
    await ensureRootDataVolumeFromImage({
      cluster: input.cluster,
      namespace: input.namespace,
      name: routerName,
      diskSize: input.diskSize,
      storageClass: input.storageClass,
      image: {
        namespace: input.image.namespace,
        name: input.image.name,
      },
      labels: roleLabels,
    });
  } catch (err) {
    throw new Error(`Failed to create router root DataVolume: ${formatError(err)}`, {
      cause: err,
    });
  }

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
            "kubevirt.io/vm": routerName,
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
                  name: routerName,
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
          "Failed to set ownerReference on router cloud-init Secret:",
          formatError(ownerErr),
        );
      }
    }

    // Stamp each VPC with router + gateway + DNS pointing at router
    for (const iface of interfaceSpecs) {
      try {
        await patchVpcRouterMetadata(input.cluster, input.namespace, iface.vpc, {
          gateway: iface.gateway,
          routerName,
          dns: [iface.gateway],
          cidr: iface.cidr,
        });
      } catch (metaErr) {
        console.error(
          `Failed to update VPC ${iface.vpc} router metadata:`,
          formatError(metaErr),
        );
      }
    }

    return {
      cluster: input.cluster,
      namespace: created.metadata?.namespace ?? input.namespace,
      name: created.metadata?.name ?? routerName,
      status: created.status?.printableStatus ?? "Provisioning",
      ready: created.status?.ready === true,
      running: true,
      allocatedIpv4: bound.map((a) => a.cidrHost).join(","),
      age: created.metadata?.creationTimestamp ?? new Date().toISOString(),
    };
  } catch (err) {
    try {
      await core.deleteNamespacedSecret({
        name: secretName,
        namespace: input.namespace,
      });
    } catch {
      /* ignore */
    }
    try {
      await deleteRouterControlPlane(input.cluster, input.namespace, routerName);
    } catch {
      /* ignore */
    }
    throw new Error(formatError(err), { cause: err });
  }
}

async function patchVpcRouterMetadata(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
  opts: {
    gateway: string;
    routerName: string;
    cidr: string;
    dns?: string[];
  },
): Promise<void> {
  const { custom } = getClusterClients(cluster);
  const existing = (await custom.getNamespacedCustomObject({
    group: "k8s.cni.cncf.io",
    version: "v1",
    namespace,
    plural: "network-attachment-definitions",
    name: vpcName,
  })) as KubeNad;

  const annotations = { ...(existing.metadata?.annotations ?? {}) };
  annotations[KMC_ANN_CIDR] = opts.cidr;
  annotations[KMC_ANN_GATEWAY] = opts.gateway;
  annotations[KMC_ANN_ROUTER] = opts.routerName;
  if (opts.dns?.length) {
    annotations[KMC_ANN_DNS] = opts.dns.join(",");
  }

  await custom.replaceNamespacedCustomObject({
    group: "k8s.cni.cncf.io",
    version: "v1",
    namespace,
    plural: "network-attachment-definitions",
    name: vpcName,
    body: {
      ...existing,
      metadata: {
        ...existing.metadata,
        annotations,
      },
    },
  });
}

/**
 * Delete router VM (if present) + control plane; clear VPC annotations.
 * Refuses if workload leases remain (unless force).
 */
export async function deleteRouter(
  cluster: ClusterId,
  namespace: string,
  name: string,
  opts?: { force?: boolean },
): Promise<void> {
  const policy = await getRouterPolicyConfigMap(cluster, namespace, name);
  if (!policy) {
    throw new Response("Router not found", { status: 404 });
  }
  const doc = policy.doc;
  const workloadLeases = (doc?.leases ?? []).filter((L) => L.vm && L.vm !== name);
  if (workloadLeases.length > 0 && !opts?.force) {
    throw new Error(
      `Router still has ${workloadLeases.length} DHCP lease(s) for workload VMs. Delete those VMs first or force-delete.`,
    );
  }

  const vpcNames = (doc?.interfaces ?? []).map((i) => i.vpc);

  const { custom, core } = getClusterClients(cluster);
  try {
    await custom.deleteNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name,
    });
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(`Failed to delete router VM: ${formatError(err)}`, {
        cause: err,
      });
    }
  }

  try {
    await custom.deleteNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      name,
    });
  } catch (err) {
    if (!isNotFound(err)) {
      console.error("delete router root DataVolume:", formatError(err));
    }
  }

  try {
    await core.deleteNamespacedSecret({
      name: cloudInitUserDataSecretName(name),
      namespace,
    });
  } catch {
    /* owned by VM or already gone */
  }

  for (const vpcName of vpcNames) {
    try {
      await clearVpcRouterAnnotation(cluster, namespace, vpcName);
    } catch (err) {
      console.error(`clear VPC ${vpcName} router ann:`, formatError(err));
    }
  }

  await deleteRouterControlPlane(cluster, namespace, name);
}

async function clearVpcRouterAnnotation(
  cluster: ClusterId,
  namespace: string,
  vpcName: string,
): Promise<void> {
  const { custom } = getClusterClients(cluster);
  const existing = (await custom.getNamespacedCustomObject({
    group: "k8s.cni.cncf.io",
    version: "v1",
    namespace,
    plural: "network-attachment-definitions",
    name: vpcName,
  })) as KubeNad;
  const annotations = { ...(existing.metadata?.annotations ?? {}) };
  delete annotations[KMC_ANN_ROUTER];
  await custom.replaceNamespacedCustomObject({
    group: "k8s.cni.cncf.io",
    version: "v1",
    namespace,
    plural: "network-attachment-definitions",
    name: vpcName,
    body: {
      ...existing,
      metadata: {
        ...existing.metadata,
        annotations,
      },
    },
  });
}

export type SetRouterExternalRequest = {
  cluster: ClusterId;
  namespace: string;
  routerName: string;
  publicMultusNetwork: string;
  sshPublicKey: string;
};

/**
 * Enable external gateway (public Multus) on an existing router.
 * Updates policy, then recreates the appliance VM with the extra NIC
 * (brief DHCP/egress downtime while the VM restarts).
 */
export async function setRouterExternalGateway(
  input: SetRouterExternalRequest,
): Promise<void> {
  const routerName = input.routerName.trim();
  const publicNet = input.publicMultusNetwork.trim();
  if (!publicNet) throw new Error("publicMultusNetwork is required");
  if (!input.sshPublicKey?.trim()) throw new Error("sshPublicKey is required");

  const policy = await getRouterPolicyConfigMap(
    input.cluster,
    input.namespace,
    routerName,
  );
  if (!policy?.doc) {
    throw new Error(`Router ${input.namespace}/${routerName} not found`);
  }
  if (policy.doc.external?.multusNetwork?.trim()) {
    throw new Error(
      `Router already has external gateway on ${policy.doc.external.multusNetwork}`,
    );
  }

  const ifaceCount = policy.doc.interfaces.length;
  if (ifaceCount + 1 > KMC_MAX_MULTUS_ATTACHMENTS) {
    throw new Error(
      `Adding external would exceed ${KMC_MAX_MULTUS_ATTACHMENTS} Multus NICs`,
    );
  }

  await ensureStaticMultusNads(input.cluster, input.namespace, [publicNet]);
  const publicPool = findIpPoolForMultus(input.cluster, publicNet);
  if (!publicPool?.gateway?.trim()) {
    throw new Error(
      `Public pool for "${publicNet}" needs a gateway for the external default route`,
    );
  }

  const publicAlloc = await allocateIpv4ForMultus(
    input.cluster,
    publicNet,
    input.namespace,
  );
  if (!publicAlloc) {
    throw new Error(`Could not allocate public IP on Multus "${publicNet}"`);
  }

  // Bind MAC for the public NIC only (private MACs already in policy).
  const publicBound = bindAllocationsToNetworks([publicNet], [publicAlloc], {
    forceMac: true,
  })[0];
  if (!publicBound?.macAddress) {
    throw new Error("Failed to assign MAC for external gateway NIC");
  }

  const doc: RouterPolicyDoc = {
    ...policy.doc,
    external: {
      multusNetwork: publicNet,
      primaryCidr: publicBound.cidrHost,
      gateway: publicPool.gateway,
      mac: publicBound.macAddress.toLowerCase(),
      snat: true,
    },
  };
  await replaceRouterPolicyDoc(input.cluster, input.namespace, routerName, doc, {
    bumpGeneration: true,
  });

  await recreateRouterVmFromPolicy({
    cluster: input.cluster,
    namespace: input.namespace,
    routerName,
    sshPublicKey: input.sshPublicKey.trim(),
  });
}

export type RecreateRouterVmRequest = {
  cluster: ClusterId;
  namespace: string;
  routerName: string;
  sshPublicKey: string;
  /**
   * Appliance shape. Required when the VirtualMachine is already gone
   * (policy-only). When the VM still exists, omitted fields are snapshotted
   * from it before delete.
   */
  image?: { kind: "pvc"; namespace: string; name: string };
  diskSize?: string;
  storageClass?: string;
  instanceType?: string;
  cpuCores?: number;
  memory?: string;
};

/**
 * Recreate the router appliance VM from policy (preserves leases/FIPs/interfaces).
 * Use when the VM was deleted out-of-band or after enabling external gateway.
 */
export async function recreateRouterVm(input: RecreateRouterVmRequest): Promise<void> {
  return recreateRouterVmFromPolicy(input);
}

/**
 * Recreate the router appliance VM from policy (preserves leases/FIPs/interfaces).
 * Snapshots size/image from the existing VM when present; otherwise requires
 * image + size fields on the request.
 */
async function recreateRouterVmFromPolicy(input: RecreateRouterVmRequest): Promise<void> {
  const { cluster, namespace, routerName, sshPublicKey } = input;
  if (!sshPublicKey?.trim()) throw new Error("sshPublicKey is required");
  const policy = await getRouterPolicyConfigMap(cluster, namespace, routerName);
  if (!policy?.doc?.interfaces?.length) {
    throw new Error("Router policy has no VPC interfaces");
  }
  const doc = policy.doc;

  // Snapshot appliance shape from existing VM before delete (when present).
  const { custom, core } = getClusterClients(cluster);
  let image = { kind: "pvc" as const, namespace: "vm-images", name: "ubuntu" };
  let diskSize = "10Gi";
  let storageClass: string | undefined;
  let instanceType: string | undefined;
  let cpuCores: number | undefined;
  let memory: string | undefined;
  let hadExistingVm = false;

  try {
    const vm = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name: routerName,
    })) as {
      spec?: {
        instancetype?: { name?: string };
        dataVolumeTemplates?: Array<{
          spec?: {
            pvc?: {
              storageClassName?: string;
              resources?: { requests?: { storage?: string } };
            };
            storage?: {
              storageClassName?: string;
              resources?: { requests?: { storage?: string } };
            };
            source?: { pvc?: { namespace?: string; name?: string } };
          };
        }>;
        template?: {
          spec?: {
            domain?: {
              resources?: { requests?: { cpu?: string; memory?: string } };
              cpu?: { cores?: number };
            };
            volumes?: Array<{ dataVolume?: { name?: string } }>;
          };
        };
      };
    };
    hadExistingVm = true;
    instanceType = vm.spec?.instancetype?.name;
    const dvt = vm.spec?.dataVolumeTemplates?.[0];
    if (dvt?.spec?.source?.pvc?.name) {
      image = {
        kind: "pvc",
        namespace: dvt.spec.source.pvc.namespace || "vm-images",
        name: dvt.spec.source.pvc.name,
      };
    }
    diskSize =
      dvt?.spec?.storage?.resources?.requests?.storage?.trim() ||
      dvt?.spec?.pvc?.resources?.requests?.storage?.trim() ||
      diskSize;
    storageClass =
      dvt?.spec?.storage?.storageClassName ||
      dvt?.spec?.pvc?.storageClassName ||
      undefined;
    // Standalone root DV (post-template): read size/class from the DV if present
    if (!dvt) {
      const rootDvName =
        vm.spec?.template?.spec?.volumes?.find((v) => v.dataVolume?.name)?.dataVolume
          ?.name || routerName;
      try {
        const dv = (await custom.getNamespacedCustomObject({
          group: "cdi.kubevirt.io",
          version: "v1beta1",
          namespace,
          plural: "datavolumes",
          name: rootDvName,
        })) as {
          spec?: {
            storage?: {
              storageClassName?: string;
              resources?: { requests?: { storage?: string } };
            };
            source?: { pvc?: { namespace?: string; name?: string } };
          };
        };
        diskSize = dv.spec?.storage?.resources?.requests?.storage?.trim() || diskSize;
        storageClass = dv.spec?.storage?.storageClassName || storageClass;
        if (dv.spec?.source?.pvc?.name) {
          image = {
            kind: "pvc",
            namespace: dv.spec.source.pvc.namespace || "vm-images",
            name: dv.spec.source.pvc.name,
          };
        }
      } catch {
        /* keep defaults */
      }
    }
    if (!instanceType) {
      cpuCores = vm.spec?.template?.spec?.domain?.cpu?.cores ?? 1;
      memory = vm.spec?.template?.spec?.domain?.resources?.requests?.memory || "1Gi";
    }
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(
        `Failed to read router VM ${namespace}/${routerName}: ${formatError(err)}`,
        { cause: err },
      );
    }
  }

  // Explicit request fields override snapshot (and supply shape when VM is gone).
  if (input.image?.name?.trim()) {
    image = {
      kind: "pvc",
      namespace: input.image.namespace?.trim() || "vm-images",
      name: input.image.name.trim(),
    };
  }
  if (input.diskSize?.trim()) diskSize = input.diskSize.trim();
  if (input.storageClass?.trim()) storageClass = input.storageClass.trim();
  if (input.instanceType?.trim()) {
    instanceType = input.instanceType.trim();
    cpuCores = undefined;
    memory = undefined;
  } else if (input.cpuCores != null || input.memory?.trim()) {
    instanceType = undefined;
    cpuCores = input.cpuCores ?? cpuCores ?? 1;
    memory = input.memory?.trim() || memory || "1Gi";
  }

  if (!hadExistingVm && !input.image?.name?.trim()) {
    throw new Error(
      `Router VM ${namespace}/${routerName} is missing — choose an image, disk size, and size to recreate the appliance from policy`,
    );
  }
  if (!instanceType && !(cpuCores && memory)) {
    throw new Error("Provide instanceType or both cpuCores and memory");
  }

  // Delete old VM + root DV + cloud-init secret (policy CM stays).
  // Fresh clone on recreate (standalone DVs no longer cascade with the VM).
  try {
    await custom.deleteNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name: routerName,
    });
  } catch (err) {
    if (!isNotFound(err)) {
      throw new Error(`Failed to delete router VM: ${formatError(err)}`, {
        cause: err,
      });
    }
  }
  try {
    await custom.deleteNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace,
      plural: "datavolumes",
      name: routerName,
    });
  } catch (err) {
    if (!isNotFound(err)) {
      console.error("delete router root DataVolume:", formatError(err));
    }
  }
  try {
    await core.deleteNamespacedSecret({
      name: cloudInitUserDataSecretName(routerName),
      namespace,
    });
  } catch {
    /* ok */
  }

  // Brief wait so the name is free
  await new Promise((r) => setTimeout(r, 1500));

  const multusNames = [
    ...doc.interfaces.map((i) => i.vpc),
    ...(doc.external?.multusNetwork ? [doc.external.multusNetwork] : []),
  ];
  // Rebuild allocations with MACs from policy (stable).
  // No default route on private NICs (this appliance *is* the gateway).
  // DNS: prefer external pool resolvers when present; private side uses
  // buildNetworkData fallbacks so wait-online --dns does not hang boot.
  const externalPool = doc.external?.multusNetwork
    ? findIpPoolForMultus(cluster, doc.external.multusNetwork)
    : undefined;
  const externalDns = (externalPool?.dns ?? []).map((d) => d.trim()).filter(Boolean);

  const allocations: AllocatedIp[] = doc.interfaces.map((iface) => {
    const gwAddr = iface.gateway.split("/")[0]!;
    const prefix = parseCidr(iface.cidr).prefix;
    return {
      poolId: `vpc:${namespace}/${iface.vpc}`,
      address: gwAddr,
      prefix,
      cidrHost: `${gwAddr}/${prefix}`,
      gateway: undefined,
      dns: externalDns,
      macAddress: iface.mac,
    };
  });
  if (doc.external?.primaryCidr && doc.external.mac) {
    const primary = doc.external.primaryCidr;
    const addr = primary.split("/")[0]!;
    const prefix = Number(primary.split("/")[1]) || 24;
    allocations.push({
      poolId: externalPool?.id ?? "external",
      address: addr,
      prefix,
      cidrHost: primary,
      gateway: doc.external.gateway,
      dns: externalDns,
      macAddress: doc.external.mac,
    });
  }

  const bound = bindAllocationsToNetworks(multusNames, allocations, {
    forceMac: true,
  });
  // Preserve policy MACs (bindAllocations may generate new ones).
  for (let i = 0; i < doc.interfaces.length; i++) {
    if (bound[i] && doc.interfaces[i]?.mac) {
      bound[i]!.macAddress = doc.interfaces[i]!.mac;
    }
  }
  if (doc.external?.mac && bound[doc.interfaces.length]) {
    bound[doc.interfaces.length]!.macAddress = doc.external.mac;
  }

  const controlPlane = await ensureRouterControlPlane({
    cluster,
    namespace,
    routerName,
    doc,
  });

  const preference = await getImagePreference(cluster, image.namespace, image.name).catch(
    () => undefined,
  );

  const createVmInput = {
    cluster,
    namespace,
    name: routerName,
    instanceType,
    cpuCores,
    memory,
    preference,
    diskSize,
    storageClass,
    image,
    networks: multusNames.map((multusNetworkName) => ({ multusNetworkName })),
    sshPublicKey,
    start: true,
  };

  const platformPub = await getPlatformConsolePublicKey();
  const knownMultusMacs = [
    ...doc.interfaces.map((i) => i.mac),
    ...(doc.external?.mac ? [doc.external.mac] : []),
  ];
  const userData = buildRouterUserData({
    sshPublicKey: [sshPublicKey, ...(platformPub ? [platformPub] : [])],
    knownMultusMacs,
    podCIDRs: controlPlane.podCIDRs,
    serviceCIDRs: controlPlane.serviceCIDRs,
    dnsIP: controlPlane.network.dnsIP,
    namespace,
    policyConfigMap: controlPlane.policyConfigMap,
    apiServer: controlPlane.apiServer,
    caData: controlPlane.caData,
    agentToken: controlPlane.token,
  });

  const secretName = cloudInitUserDataSecretName(routerName);
  const roleLabels = {
    [KMC_LABEL_ROLE]: KMC_ROLE_ROUTER,
    [KMC_LABEL_ROUTER]: routerName,
  };
  const clusterCidrs = [...controlPlane.podCIDRs, ...controlPlane.serviceCIDRs].filter(
    Boolean,
  );
  const externalAlloc =
    doc.external?.primaryCidr && doc.external.mac
      ? (bound[doc.interfaces.length] ?? null)
      : null;
  const body = buildVirtualMachineManifest(createVmInput, bound, {
    labels: roleLabels,
    userDataSecretName: secretName,
    includePodNetwork: true,
    clusterCidrs,
    routerAgentOwnsPrivateL3: true,
    routerExternalAllocation: externalAlloc,
  });

  await ensureRootDataVolumeFromImage({
    cluster,
    namespace,
    name: routerName,
    diskSize,
    storageClass,
    image: { namespace: image.namespace, name: image.name },
    labels: roleLabels,
    replace: true,
  });

  await core.createNamespacedSecret({
    namespace,
    body: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: secretName,
        namespace,
        labels: {
          [MANAGED_BY_LABEL]: KMC_MANAGED_BY,
          ...roleLabels,
          "kubevirt.io/vm": routerName,
        },
      },
      type: "Opaque",
      stringData: { userdata: userData },
    },
  });

  const created = (await custom.createNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace,
    plural: "virtualmachines",
    body,
  })) as KubeVm;

  const uid = created.metadata?.uid;
  if (uid) {
    try {
      const secret = await core.readNamespacedSecret({ name: secretName, namespace });
      await core.replaceNamespacedSecret({
        name: secretName,
        namespace,
        body: {
          ...secret,
          metadata: {
            ...secret.metadata,
            ownerReferences: [
              {
                apiVersion: "kubevirt.io/v1",
                kind: "VirtualMachine",
                name: routerName,
                uid,
                controller: true,
                blockOwnerDeletion: true,
              },
            ],
          },
        },
      });
    } catch {
      /* best-effort */
    }
  }

  // Re-stamp floating IPs onto the new VM for IPAM scans
  if (doc.floatingIPs.length > 0) {
    const floats = floatingIpsFromRouterDoc(doc);
    const annotations: Record<string, string> = {};
    if (floats.length > 0) {
      const { KMC_ANN_FLOATING_IPV4: key } = await import("~/lib/k8s/constants");
      annotations[key] = floats.map((f) => `${f.public}/${f.prefix}`).join(",");
      try {
        const vm = (await custom.getNamespacedCustomObject({
          group: "kubevirt.io",
          version: "v1",
          namespace,
          plural: "virtualmachines",
          name: routerName,
        })) as {
          metadata?: { annotations?: Record<string, string> };
          [k: string]: unknown;
        };
        await custom.replaceNamespacedCustomObject({
          group: "kubevirt.io",
          version: "v1",
          namespace,
          plural: "virtualmachines",
          name: routerName,
          body: {
            ...vm,
            metadata: {
              ...(vm.metadata as object),
              annotations: {
                ...(vm.metadata?.annotations ?? {}),
                ...annotations,
              },
            },
          },
        });
      } catch (err) {
        console.error("re-stamp floating IPs on router:", formatError(err));
      }
    }
  }
}

type KubeVmNetworks = {
  metadata?: {
    name?: string;
    namespace?: string;
    resourceVersion?: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
  };
  spec?: {
    template?: {
      spec?: {
        domain?: {
          devices?: {
            interfaces?: Array<Record<string, unknown>>;
          };
        };
        networks?: Array<{
          name?: string;
          pod?: object;
          multus?: { networkName?: string };
        }>;
      };
    };
  };
  [k: string]: unknown;
};

/** Next free Multus interface name on a dual-home router (pod is reserved). */
function nextRouterMultusInterfaceName(usedNames: Set<string>): string {
  // Prefer net0, net1, … so hotplug never renames create-time `default`.
  for (let i = 0; i < 16; i++) {
    const candidate = `net${i}`;
    if (!usedNames.has(candidate) && candidate !== POD_NETWORK_NAME) {
      return candidate;
    }
  }
  if (!usedNames.has("default")) {
    return "default";
  }
  throw new Error("No free Multus interface name on router VM");
}

async function readRouterVm(
  cluster: ClusterId,
  namespace: string,
  routerName: string,
): Promise<KubeVmNetworks> {
  const { custom } = getClusterClients(cluster);
  try {
    return (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name: routerName,
    })) as KubeVmNetworks;
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(
        `Router VM ${namespace}/${routerName} is missing — recreate the appliance before attaching VPCs`,
      );
    }
    throw new Error(formatError(err), { cause: err });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type KubeVmStatus = {
  status?: {
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
    }>;
  };
};

type KubeVmiStatus = {
  status?: {
    interfaces?: Array<{
      name?: string;
      interfaceName?: string;
      ipAddress?: string;
    }>;
  };
  spec?: {
    networks?: Array<{
      name?: string;
      multus?: { networkName?: string };
    }>;
  };
};

function multusNetworkMatches(
  networkName: string | undefined,
  namespace: string,
  vpcName: string,
): boolean {
  const nn = networkName?.trim() ?? "";
  return (
    nn === vpcName ||
    nn === `${namespace}/${vpcName}` ||
    nn.endsWith(`/${vpcName}`)
  );
}

/**
 * True when the VMI already has a live guest interface for this Multus VPC.
 */
async function routerVmiHasLiveMultus(
  cluster: ClusterId,
  namespace: string,
  routerName: string,
  vpcName: string,
): Promise<boolean> {
  const { custom } = getClusterClients(cluster);
  try {
    const vmi = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachineinstances",
      name: routerName,
    })) as KubeVmiStatus;
    const nets = vmi.spec?.networks ?? [];
    const liveNames = new Set(
      (vmi.status?.interfaces ?? [])
        .map((i) => i.name)
        .filter((n): n is string => Boolean(n)),
    );
    // Prefer matching by Multus networkName → interface name on status
    for (const n of nets) {
      if (!multusNetworkMatches(n.multus?.networkName, namespace, vpcName)) {
        continue;
      }
      if (n.name && liveNames.has(n.name)) return true;
    }
    // Fallback: any status iface named like the VPC
    return liveNames.has(vpcName);
  } catch {
    return false;
  }
}

async function vmHasRestartRequired(
  cluster: ClusterId,
  namespace: string,
  routerName: string,
): Promise<boolean> {
  const { custom } = getClusterClients(cluster);
  try {
    const vm = (await custom.getNamespacedCustomObject({
      group: "kubevirt.io",
      version: "v1",
      namespace,
      plural: "virtualmachines",
      name: routerName,
    })) as KubeVmStatus;
    return (vm.status?.conditions ?? []).some(
      (c) => c.type === "RestartRequired" && c.status === "True",
    );
  } catch {
    return false;
  }
}

/**
 * After Multus attach/detach, wait briefly for the live NIC state. If KubeVirt
 * only staged the change (RestartRequired — common when the root PVC is RWO and
 * LiveUpdate migration cannot run), hard-restart the appliance so the NIC
 * lands. Policy/disks/leases are preserved (not a recreate).
 */
async function ensureRouterMultusApplied(input: {
  cluster: ClusterId;
  namespace: string;
  routerName: string;
  /** VPC we expect to be present (attach) or absent (detach). */
  vpcName: string;
  expectPresent: boolean;
}): Promise<{ restarted: boolean }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const live = await routerVmiHasLiveMultus(
      input.cluster,
      input.namespace,
      input.routerName,
      input.vpcName,
    );
    const applied = input.expectPresent ? live : !live;
    const restartRequired = await vmHasRestartRequired(
      input.cluster,
      input.namespace,
      input.routerName,
    );
    // Fully applied and no pending restart — done (true live hotplug).
    if (applied && !restartRequired) {
      return { restarted: false };
    }
    await sleep(1500);
  }

  const live = await routerVmiHasLiveMultus(
    input.cluster,
    input.namespace,
    input.routerName,
    input.vpcName,
  );
  const applied = input.expectPresent ? live : !live;
  const restartRequired = await vmHasRestartRequired(
    input.cluster,
    input.namespace,
    input.routerName,
  );
  if (applied && !restartRequired) {
    return { restarted: false };
  }

  await restartVm(input.cluster, input.namespace, input.routerName);
  return { restarted: true };
}

/**
 * Hotplug a Multus NIC onto the running router VM (no recreate).
 * Requires cluster Multus dynamic networks / KubeVirt NIC hotplug support.
 */
async function hotplugRouterMultusNic(input: {
  cluster: ClusterId;
  namespace: string;
  routerName: string;
  vpcName: string;
  macAddress: string;
}): Promise<void> {
  const { custom } = getClusterClients(input.cluster);
  const vm = await readRouterVm(input.cluster, input.namespace, input.routerName);
  const templateSpec = vm.spec?.template?.spec;
  if (!templateSpec) {
    throw new Error("Router VM has no template spec");
  }
  const networks = [...(templateSpec.networks ?? [])];
  const interfaces = [
    ...((templateSpec.domain?.devices?.interfaces as Array<Record<string, unknown>>) ??
      []),
  ];

  const already = networks.some(
    (n) =>
      n.multus?.networkName === input.vpcName ||
      n.multus?.networkName === `${input.namespace}/${input.vpcName}`,
  );
  if (already) {
    return;
  }

  const usedNames = new Set([
    ...networks.map((n) => n.name).filter(Boolean),
    ...interfaces.map((i) => String(i.name ?? "")).filter(Boolean),
  ] as string[]);
  const ifaceName = nextRouterMultusInterfaceName(usedNames);
  const mac = input.macAddress.trim().toLowerCase();

  networks.push({
    name: ifaceName,
    multus: { networkName: input.vpcName },
  });
  interfaces.push({
    name: ifaceName,
    bridge: {},
    macAddress: mac,
  });

  const nextVm: KubeVmNetworks = {
    ...vm,
    spec: {
      ...vm.spec,
      template: {
        ...vm.spec?.template,
        spec: {
          ...templateSpec,
          networks,
          domain: {
            ...templateSpec.domain,
            devices: {
              ...templateSpec.domain?.devices,
              interfaces,
            },
          },
        },
      },
    },
  };

  await custom.replaceNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace: input.namespace,
    plural: "virtualmachines",
    name: input.routerName,
    body: nextVm,
  });
}

/**
 * Hot-unplug a Multus NIC from the router VM by marking the interface absent.
 */
async function hotunplugRouterMultusNic(input: {
  cluster: ClusterId;
  namespace: string;
  routerName: string;
  vpcName: string;
}): Promise<void> {
  const { custom } = getClusterClients(input.cluster);
  let vm: KubeVmNetworks;
  try {
    vm = await readRouterVm(input.cluster, input.namespace, input.routerName);
  } catch {
    // VM already gone — policy detach is enough
    return;
  }
  const templateSpec = vm.spec?.template?.spec;
  if (!templateSpec) return;

  const networks = [...(templateSpec.networks ?? [])];
  const interfaces = [
    ...((templateSpec.domain?.devices?.interfaces as Array<Record<string, unknown>>) ??
      []),
  ];

  const matchNet = (n: { multus?: { networkName?: string } }) => {
    const nn = n.multus?.networkName?.trim() ?? "";
    return (
      nn === input.vpcName ||
      nn === `${input.namespace}/${input.vpcName}` ||
      nn.endsWith(`/${input.vpcName}`)
    );
  };

  const targetNetworks = networks.filter(matchNet);
  if (targetNetworks.length === 0) return;

  const targetNames = new Set(
    targetNetworks.map((n) => n.name).filter(Boolean) as string[],
  );

  const nextInterfaces = interfaces.map((iface) => {
    const name = String(iface.name ?? "");
    if (!targetNames.has(name)) return iface;
    return { ...iface, state: "absent" };
  });

  const nextVm: KubeVmNetworks = {
    ...vm,
    spec: {
      ...vm.spec,
      template: {
        ...vm.spec?.template,
        spec: {
          ...templateSpec,
          // Keep networks listed while state:absent is processed by KubeVirt
          networks,
          domain: {
            ...templateSpec.domain,
            devices: {
              ...templateSpec.domain?.devices,
              interfaces: nextInterfaces,
            },
          },
        },
      },
    },
  };

  await custom.replaceNamespacedCustomObject({
    group: "kubevirt.io",
    version: "v1",
    namespace: input.namespace,
    plural: "virtualmachines",
    name: input.routerName,
    body: nextVm,
  });
}

/**
 * Attach a free VPC to an existing router via policy update + Multus hotplug.
 * Does **not** recreate the appliance or require an SSH key. Agent assigns L3.
 * When the cluster cannot live-apply Multus (RWO disk / no LiveUpdate migration),
 * restarts the router VM so the NIC lands.
 */
export async function attachRouterVpc(
  input: AttachRouterVpcRequest,
): Promise<{ restarted: boolean }> {
  const routerName = input.routerName.trim();
  const vpcName = input.vpcName.trim();
  if (!routerName) throw new Error("routerName is required");
  if (!vpcName) throw new Error("vpcName is required");

  const policy = await getRouterPolicyConfigMap(
    input.cluster,
    input.namespace,
    routerName,
  );
  if (!policy?.doc) {
    throw new Error(`Router ${input.namespace}/${routerName} not found`);
  }
  const doc = policy.doc;

  // Ensure appliance exists (hotplug needs a live VM template)
  await readRouterVm(input.cluster, input.namespace, routerName);

  if (doc.interfaces.some((i) => i.vpc === vpcName)) {
    throw new Error(`VPC ${vpcName} is already attached to this router`);
  }

  const vpc = await loadVpcAttachInfo(input.cluster, input.namespace, vpcName);
  if (vpc.routerAnn && vpc.routerAnn !== routerName) {
    throw new Error(`VPC ${vpcName} is already attached to router ${vpc.routerAnn}`);
  }

  // Distinct CIDR strings (same as create)
  const existingCidrs = new Set(doc.interfaces.map((i) => i.cidr.trim()));
  if (existingCidrs.has(vpc.cidr.trim())) {
    throw new Error(
      `VPC ${vpcName} CIDR ${vpc.cidr} is already used by another interface on this router`,
    );
  }

  const externalExtra = doc.external?.multusNetwork ? 1 : 0;
  if (doc.interfaces.length + 1 + externalExtra > KMC_MAX_MULTUS_ATTACHMENTS) {
    throw new Error(
      `At most ${KMC_MAX_MULTUS_ATTACHMENTS} Multus NICs (VPCs + optional external) are supported`,
    );
  }

  const privateGateway = vpc.gateway?.trim() || defaultGatewayAddress(vpc.cidr);
  validateGatewayInCidr(vpc.cidr, privateGateway);

  const extraUsed = doc.interfaces.map((i) => i.gateway.split("/")[0]!).filter(Boolean);
  const alloc = await allocateIpv4ForMultus(input.cluster, vpcName, input.namespace, {
    preferredAddress: privateGateway,
    claimGateway: true,
    gatewayOverride: null,
    extraUsed,
  });
  if (!alloc) {
    throw new Error(`Could not allocate gateway IP on VPC ${input.namespace}/${vpcName}`);
  }

  const mac = generateLocalMacAddress().toLowerCase();

  try {
    await mutateRouterPolicyDoc(
      input.cluster,
      input.namespace,
      routerName,
      (d) => {
        if (d.interfaces.some((i) => i.vpc === vpcName)) {
          return false;
        }
        d.interfaces.push({
          vpc: vpcName,
          cidr: vpc.cidr.trim(),
          gateway: privateGateway,
          mac,
          domain: defaultRouterDomain(vpcName),
          dhcp: {
            enabled: true,
            leaseTime: "12h",
            authoritative: true,
          },
        });
      },
      { bumpGeneration: true },
    );

    await hotplugRouterMultusNic({
      cluster: input.cluster,
      namespace: input.namespace,
      routerName,
      vpcName,
      macAddress: mac,
    });

    await patchVpcRouterMetadata(input.cluster, input.namespace, vpcName, {
      gateway: privateGateway,
      routerName,
      dns: [privateGateway],
      cidr: vpc.cidr.trim(),
    });

    // Create stamps IPAM via the VM template only; re-sync so post-create
    // VPC gateways appear in "IPv4 (allocated)" and free-IP scans.
    const afterAttach = await getRouterPolicyConfigMap(
      input.cluster,
      input.namespace,
      routerName,
    );
    if (afterAttach?.doc) {
      await syncRouterVmIpamAnnotationsFromPolicy(
        input.cluster,
        input.namespace,
        routerName,
        afterAttach.doc,
      );
    }

    const applied = await ensureRouterMultusApplied({
      cluster: input.cluster,
      namespace: input.namespace,
      routerName,
      vpcName,
      expectPresent: true,
    });
    return applied;
  } catch (err) {
    // Best-effort rollback: drop interface from policy if hotplug/metadata failed
    try {
      await mutateRouterPolicyDoc(
        input.cluster,
        input.namespace,
        routerName,
        (d) => {
          const before = d.interfaces.length;
          d.interfaces = d.interfaces.filter(
            (i) => !(i.vpc === vpcName && i.mac === mac),
          );
          if (d.interfaces.length === before) return false;
        },
        { bumpGeneration: true },
      );
    } catch {
      /* ignore */
    }
    try {
      await clearVpcRouterAnnotation(input.cluster, input.namespace, vpcName);
    } catch {
      /* ignore */
    }
    try {
      const rolled = await getRouterPolicyConfigMap(
        input.cluster,
        input.namespace,
        routerName,
      );
      if (rolled?.doc) {
        await syncRouterVmIpamAnnotationsFromPolicy(
          input.cluster,
          input.namespace,
          routerName,
          rolled.doc,
        );
      }
    } catch {
      /* ignore */
    }
    throw new Error(formatError(err), { cause: err });
  }
}

/**
 * Detach a VPC from a multi-VPC router (policy + Multus hot-unplug, no recreate).
 * Restarts the appliance when KubeVirt cannot live-unplug (same RWO case as attach).
 */
export async function detachRouterVpc(
  input: DetachRouterVpcRequest,
): Promise<{ restarted: boolean }> {
  const routerName = input.routerName.trim();
  const vpcName = input.vpcName.trim();
  if (!routerName) throw new Error("routerName is required");
  if (!vpcName) throw new Error("vpcName is required");

  const policy = await getRouterPolicyConfigMap(
    input.cluster,
    input.namespace,
    routerName,
  );
  if (!policy?.doc) {
    throw new Error(`Router ${input.namespace}/${routerName} not found`);
  }
  const doc = policy.doc;
  if (!doc.interfaces.some((i) => i.vpc === vpcName)) {
    throw new Error(`VPC ${vpcName} is not attached to this router`);
  }
  if (doc.interfaces.length <= 1) {
    throw new Error("Cannot detach the last VPC interface — delete the router instead");
  }

  const workloadLeases = (doc.leases ?? []).filter(
    (L) => L.vpc === vpcName && L.vm && L.vm !== routerName,
  );
  // Prefer explicit vpc tag; also count FIPs whose private is in this VPC CIDR
  const fipsForVpc = (doc.floatingIPs ?? []).filter((f) => {
    if (!f.private?.trim()) return false;
    if (f.vpc === vpcName) return true;
    if (f.vpc && f.vpc !== vpcName) return false;
    const iface = doc.interfaces.find((i) => i.vpc === vpcName);
    if (!iface) return false;
    try {
      return containsIpv4(parseCidr(iface.cidr), f.private.split("/")[0]!);
    } catch {
      return false;
    }
  });
  const pfsForVpc = (doc.portForwards ?? []).filter((pf) => {
    if (pf.vpc === vpcName) return true;
    if (pf.vpc && pf.vpc !== vpcName) return false;
    const iface = doc.interfaces.find((i) => i.vpc === vpcName);
    if (!iface) return false;
    try {
      return containsIpv4(parseCidr(iface.cidr), pf.private.split("/")[0]!);
    } catch {
      return false;
    }
  });

  if (workloadLeases.length > 0 && !input.force) {
    throw new Error(
      `VPC ${vpcName} still has ${workloadLeases.length} DHCP lease(s) for workload VMs. Delete those VMs first or force-detach.`,
    );
  }
  if (fipsForVpc.length > 0 && !input.force) {
    throw new Error(
      `VPC ${vpcName} still has ${fipsForVpc.length} active floating IP(s). Disassociate them first or force-detach (holds public addresses).`,
    );
  }
  if (pfsForVpc.length > 0 && !input.force) {
    throw new Error(
      `VPC ${vpcName} still has ${pfsForVpc.length} port forward(s). Delete them first or force-detach.`,
    );
  }

  let heldFloats = false;
  await mutateRouterPolicyDoc(
    input.cluster,
    input.namespace,
    routerName,
    (d) => {
      d.interfaces = d.interfaces.filter((i) => i.vpc !== vpcName);
      d.leases = (d.leases ?? []).filter((L) => L.vpc !== vpcName);
      d.floatingIPs = (d.floatingIPs ?? []).map((f) => {
        const matches =
          f.vpc === vpcName ||
          (Boolean(f.private?.trim()) &&
            !f.vpc &&
            (() => {
              // private in detached CIDR — use pre-detach iface from outer doc
              const iface = doc.interfaces.find((i) => i.vpc === vpcName);
              if (!iface || !f.private) return false;
              try {
                return containsIpv4(parseCidr(iface.cidr), f.private.split("/")[0]!);
              } catch {
                return false;
              }
            })());
        if (!matches || !f.private?.trim()) return f;
        heldFloats = true;
        return {
          id: f.id,
          public: f.public,
          prefix: f.prefix,
          protocol: f.protocol ?? "all",
          vpc: f.vpc ?? vpcName,
        };
      });
      d.portForwards = (d.portForwards ?? []).filter((pf) => {
        if (pf.vpc === vpcName) return false;
        if (pf.vpc && pf.vpc !== vpcName) return true;
        const iface = doc.interfaces.find((i) => i.vpc === vpcName);
        if (!iface) return true;
        try {
          return !containsIpv4(parseCidr(iface.cidr), pf.private.split("/")[0]!);
        } catch {
          return true;
        }
      });
    },
    { bumpGeneration: true },
  );

  try {
    await hotunplugRouterMultusNic({
      cluster: input.cluster,
      namespace: input.namespace,
      routerName,
      vpcName,
    });
  } catch (err) {
    console.error("hotunplugRouterMultusNic:", formatError(err));
    // Policy already updated — surface but do not leave annotation set
  }

  try {
    await clearVpcRouterAnnotation(input.cluster, input.namespace, vpcName);
  } catch (err) {
    console.error(`clear VPC ${vpcName} router ann:`, formatError(err));
  }

  const next = await getRouterPolicyConfigMap(
    input.cluster,
    input.namespace,
    routerName,
  );
  if (next?.doc) {
    try {
      await syncRouterVmIpamAnnotationsFromPolicy(
        input.cluster,
        input.namespace,
        routerName,
        next.doc,
      );
    } catch (err) {
      console.error(
        `sync IPAM annotations after detach VPC ${vpcName}:`,
        formatError(err),
      );
    }
    if (heldFloats) {
      await syncRouterFloatingAnnotation(
        input.cluster,
        input.namespace,
        routerName,
        floatingIpsFromRouterDoc(next.doc),
      );
    }
  }

  return ensureRouterMultusApplied({
    cluster: input.cluster,
    namespace: input.namespace,
    routerName,
    vpcName,
    expectPresent: false,
  });
}

/**
 * Routers in the same namespace that can attach this VPC (budget + no CIDR overlap).
 * Used from VPC detail “Attach existing router”.
 */
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
    /** Multus NICs already on the router (VPCs + optional external). */
    multusCount: number;
  }>
> {
  const vpc = await loadVpcAttachInfo(cluster, namespace, vpcName);
  if (vpc.routerAnn) {
    return [];
  }
  if (!vpc.cidr?.trim()) {
    return [];
  }
  const vpcCidr = vpc.cidr.trim();

  const policies = await listRouterPolicyConfigMaps(cluster);
  const out: Array<{
    name: string;
    vpcNames: string[];
    hasExternal: boolean;
    agentStatus?: string;
    multusCount: number;
  }> = [];

  for (const p of policies) {
    if (p.namespace !== namespace || !p.doc) continue;
    const doc = p.doc;
    if (doc.interfaces.some((i) => i.vpc === vpcName)) continue;

    const hasExternal = Boolean(doc.external?.multusNetwork?.trim());
    const multusCount = doc.interfaces.length + (hasExternal ? 1 : 0);
    if (multusCount + 1 > KMC_MAX_MULTUS_ATTACHMENTS) continue;

    const existingCidrs = new Set(
      doc.interfaces.map((i) => i.cidr.trim()).filter(Boolean),
    );
    if (existingCidrs.has(vpcCidr)) continue;

    const agent = agentInfoFromRouterAnnotations(p.annotations);
    out.push({
      name: p.routerName,
      vpcNames: doc.interfaces.map((i) => i.vpc).filter(Boolean),
      hasExternal,
      agentStatus: agent.agentStatus,
      multusCount,
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** VPCs in a namespace that can accept a new router interface. */
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
  const { custom } = getClusterClients(cluster);
  const res = (await custom.listNamespacedCustomObject({
    group: "k8s.cni.cncf.io",
    version: "v1",
    namespace,
    plural: "network-attachment-definitions",
    labelSelector: KMC_VPC_LABEL_SELECTOR,
  })) as { items?: KubeNad[] };

  const out: Array<{
    name: string;
    cidr?: string;
    gateway?: string;
    attachedRouter?: string;
  }> = [];

  for (const nad of res.items ?? []) {
    const name = nad.metadata?.name ?? "";
    if (!name) continue;
    const labels = nad.metadata?.labels ?? {};
    if (labels[KMC_LABEL_RESOURCE] && labels[KMC_LABEL_RESOURCE] !== KMC_RESOURCE_VPC) {
      continue;
    }
    const ann = nad.metadata?.annotations ?? {};
    out.push({
      name,
      cidr: ann[KMC_ANN_CIDR],
      gateway: ann[KMC_ANN_GATEWAY],
      attachedRouter: ann[KMC_ANN_ROUTER]?.trim() || undefined,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export { routerPolicyConfigMapName, defaultRouterDomain };
