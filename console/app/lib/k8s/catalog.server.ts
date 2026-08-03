import type {
  ClusterCatalog,
  ClusterId,
  InstanceTypeInfo,
  NamespaceInfo,
  NetworkInfo,
  PreferenceInfo,
  StorageClassInfo,
} from "~/lib/types";
import {
  getIpPoolUsageForConfig,
  listIpPools,
  resolveIpPoolForMultus,
} from "~/lib/ipam/pools.server";
import { getClusterClients } from "./clients.server";
import {
  IMAGE_PREFERENCE_LABEL,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_VLAN,
  KMC_RESOURCE_VPC,
  VM_ALLOWED_LABEL,
  VM_ALLOWED_LABEL_SELECTOR,
} from "./constants";
import { getImageNamespace, listReadyImages } from "./image-catalog.server";
import { nadNameFromMultusRef } from "./static-nads.server";

/**
 * Ensures the target namespace is labeled for VM creation.
 * Catalog UI already filters, but create must reject forged form posts.
 */
export async function assertVmNamespaceAllowed(
  cluster: ClusterId,
  namespace: string,
): Promise<void> {
  const { core } = getClusterClients(cluster);
  let ns;
  try {
    ns = await core.readNamespace({ name: namespace });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404") || message.toLowerCase().includes("not found")) {
      throw new Error(`Namespace "${namespace}" was not found`);
    }
    throw err;
  }
  const value = ns.metadata?.labels?.[VM_ALLOWED_LABEL];
  if (value !== "true") {
    throw new Error(
      `Namespace "${namespace}" is not allowed for VM launch ` +
        `(requires label ${VM_ALLOWED_LABEL}=true)`,
    );
  }
}

export async function getClusterCatalog(cluster: ClusterId): Promise<ClusterCatalog> {
  const { custom, core, storage } = getClusterClients(cluster);

  const [namespaces, instanceTypes, preferences, storageClasses, images] =
    await Promise.all([
      listNamespaces(core),
      listInstanceTypes(custom),
      listPreferences(custom),
      listStorageClasses(storage),
      listReadyImages(cluster),
    ]);

  const defaultStorageClass =
    storageClasses.find((s) => s.isDefault)?.name ?? storageClasses[0]?.name;

  return {
    namespaces,
    instanceTypes,
    preferences,
    storageClasses,
    images,
    defaultStorageClass,
    hasInstanceTypes: instanceTypes.length > 0,
  };
}

export async function listNetworks(
  cluster: ClusterId,
  namespace: string,
): Promise<NetworkInfo[]> {
  if (!namespace) return [];
  const { custom } = getClusterClients(cluster);
  try {
    const res = (await custom.listNamespacedCustomObject({
      group: "k8s.cni.cncf.io",
      version: "v1",
      namespace,
      plural: "network-attachment-definitions",
    })) as {
      items?: Array<{
        metadata?: {
          name?: string;
          namespace?: string;
          labels?: Record<string, string>;
        };
      }>;
    };
    const networks: NetworkInfo[] = (res.items ?? [])
      .map((item) => {
        const labels = item.metadata?.labels ?? {};
        const isVpc = labels[KMC_LABEL_RESOURCE] === KMC_RESOURCE_VPC;
        const vlanRaw = labels[KMC_LABEL_VLAN];
        const vlan = vlanRaw ? Number(vlanRaw) : undefined;
        return {
          name: item.metadata?.name ?? "",
          namespace: item.metadata?.namespace ?? namespace,
          kind: isVpc ? ("vpc" as const) : ("multus" as const),
          vlan: vlan != null && Number.isInteger(vlan) && vlan > 0 ? vlan : undefined,
        };
      })
      .filter((n) => n.name);

    // Static IPPool CRs with a cni template are selectable even before the NAD is
    // created (createVm ensures the NAD). Without this, new namespaces never
    // list external / bridge-external in the launch picker.
    const existingNames = new Set(networks.map((n) => n.name));
    for (const pool of await listIpPools(cluster)) {
      if (!pool.cni) continue;
      const nadName = nadNameFromMultusRef(pool.multusNetwork);
      if (!nadName || existingNames.has(nadName)) continue;
      networks.push({
        name: nadName,
        namespace,
        kind: "multus",
        vlan: pool.cni.vlan,
      });
      existingNames.add(nadName);
    }

    networks.sort((a, b) => a.name.localeCompare(b.name));

    // Attach IP pool usage from static IPPool CRs and/or VPC NAD annotations.
    const usageByPoolId = new Map<
      string,
      Awaited<ReturnType<typeof getIpPoolUsageForConfig>> | null
    >();

    return Promise.all(
      networks.map(async (n) => {
        const pool = await resolveIpPoolForMultus(cluster, n.name, namespace);
        if (!pool) return n as NetworkInfo;
        let usage = usageByPoolId.get(pool.id);
        if (usage === undefined) {
          try {
            usage = await getIpPoolUsageForConfig(cluster, pool);
          } catch {
            usage = null;
          }
          usageByPoolId.set(pool.id, usage);
        }
        if (!usage) {
          return {
            ...n,
            ipPool: {
              id: pool.id,
              cidr: pool.cidr,
              free: 0,
              total: 0,
              gateway: pool.gateway,
            },
          } satisfies NetworkInfo;
        }
        return {
          ...n,
          ipPool: {
            id: usage.pool.id,
            cidr: usage.cidr,
            free: usage.free,
            total: usage.total,
            gateway: usage.pool.gateway,
          },
        } satisfies NetworkInfo;
      }),
    );
  } catch {
    return [];
  }
}

async function listNamespaces(
  core: ReturnType<typeof getClusterClients>["core"],
): Promise<NamespaceInfo[]> {
  // Only namespaces explicitly opted-in for VM / workload creation.
  const res = await core.listNamespace({
    labelSelector: VM_ALLOWED_LABEL_SELECTOR,
  });
  return (res.items ?? [])
    .map((ns) => ({ name: ns.metadata?.name ?? "" }))
    .filter((n) => n.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listInstanceTypes(
  custom: ReturnType<typeof getClusterClients>["custom"],
): Promise<InstanceTypeInfo[]> {
  try {
    const res = (await custom.listClusterCustomObject({
      group: "instancetype.kubevirt.io",
      version: "v1beta1",
      plural: "virtualmachineclusterinstancetypes",
    })) as {
      items?: Array<{
        metadata?: {
          name?: string;
          labels?: Record<string, string>;
        };
        spec?: {
          cpu?: { guest?: number };
          memory?: { guest?: string };
        };
      }>;
    };
    return (res.items ?? [])
      .map((item) => {
        const labels = item.metadata?.labels ?? {};
        return {
          name: item.metadata?.name ?? "",
          cpu:
            item.spec?.cpu?.guest != null
              ? String(item.spec.cpu.guest)
              : labels["instancetype.kubevirt.io/cpu"],
          memory: item.spec?.memory?.guest ?? labels["instancetype.kubevirt.io/memory"],
          class: labels["instancetype.kubevirt.io/class"] || undefined,
          size: labels["instancetype.kubevirt.io/size"] || undefined,
          vendor: labels["instancetype.kubevirt.io/vendor"] || undefined,
        } satisfies InstanceTypeInfo;
      })
      .filter((i) => i.name);
  } catch {
    return [];
  }
}

async function listPreferences(
  custom: ReturnType<typeof getClusterClients>["custom"],
): Promise<PreferenceInfo[]> {
  try {
    const res = (await custom.listClusterCustomObject({
      group: "instancetype.kubevirt.io",
      version: "v1beta1",
      plural: "virtualmachineclusterpreferences",
    })) as { items?: Array<{ metadata?: { name?: string } }> };
    return (res.items ?? [])
      .map((item) => ({ name: item.metadata?.name ?? "" }))
      .filter((p) => p.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function listStorageClasses(
  storage: ReturnType<typeof getClusterClients>["storage"],
): Promise<StorageClassInfo[]> {
  const res = await storage.listStorageClass();
  return (res.items ?? [])
    .map((sc) => {
      const annotations = sc.metadata?.annotations ?? {};
      const isDefault =
        annotations["storageclass.kubernetes.io/is-default-class"] === "true" ||
        annotations["storageclass.beta.kubernetes.io/is-default-class"] === "true";
      return {
        name: sc.metadata?.name ?? "",
        isDefault,
        provisioner: sc.provisioner,
      };
    })
    .filter((s) => s.name)
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Reads the cluster-preference label from a golden image PVC (preferred) or
 * owning DataVolume. Used at VM create so preference is never taken from a
 * free-form form field.
 */
export async function getImagePreference(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<string | undefined> {
  const { core, custom } = getClusterClients(cluster);
  try {
    const pvc = await core.readNamespacedPersistentVolumeClaim({ name, namespace });
    const fromPvc = pvc.metadata?.labels?.[IMAGE_PREFERENCE_LABEL]?.trim();
    if (fromPvc) return fromPvc;
  } catch {
    // fall through to DV
  }
  try {
    const dv = (await custom.getNamespacedCustomObject({
      group: "cdi.kubevirt.io",
      version: "v1beta1",
      namespace: namespace || getImageNamespace(),
      plural: "datavolumes",
      name,
    })) as { metadata?: { labels?: Record<string, string> } };
    const fromDv = dv.metadata?.labels?.[IMAGE_PREFERENCE_LABEL]?.trim();
    return fromDv || undefined;
  } catch {
    return undefined;
  }
}
