import type {
  ClusterCatalog,
  ClusterId,
  ImageInfo,
  InstanceTypeInfo,
  NamespaceInfo,
  NetworkInfo,
  PreferenceInfo,
  StorageClassInfo,
} from "~/lib/types";
import { getClusterClients } from "./clients.server";

const IMAGE_NAMESPACE = process.env.KMC_IMAGE_NAMESPACE ?? "vm-images";

export async function getClusterCatalog(cluster: ClusterId): Promise<ClusterCatalog> {
  const { custom, core, storage } = getClusterClients(cluster);

  const [namespaces, instanceTypes, preferences, storageClasses, images] =
    await Promise.all([
      listNamespaces(core),
      listInstanceTypes(custom),
      listPreferences(custom),
      listStorageClasses(storage),
      listImages(core),
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
      items?: Array<{ metadata?: { name?: string; namespace?: string } }>;
    };
    return (res.items ?? [])
      .map((item) => ({
        name: item.metadata?.name ?? "",
        namespace: item.metadata?.namespace ?? namespace,
      }))
      .filter((n) => n.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function listNamespaces(
  core: ReturnType<typeof getClusterClients>["core"],
): Promise<NamespaceInfo[]> {
  const res = await core.listNamespace();
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
        metadata?: { name?: string };
        spec?: {
          cpu?: { guest?: number };
          memory?: { guest?: string };
        };
      }>;
    };
    return (res.items ?? [])
      .map((item) => ({
        name: item.metadata?.name ?? "",
        cpu: item.spec?.cpu?.guest != null ? String(item.spec.cpu.guest) : undefined,
        memory: item.spec?.memory?.guest,
      }))
      .filter((i) => i.name)
      .sort((a, b) => a.name.localeCompare(b.name));
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

async function listImages(
  core: ReturnType<typeof getClusterClients>["core"],
): Promise<ImageInfo[]> {
  try {
    const res = await core.listNamespacedPersistentVolumeClaim({
      namespace: IMAGE_NAMESPACE,
    });
    return (res.items ?? [])
      .filter((pvc) => pvc.status?.phase === "Bound")
      .map((pvc) => ({
        name: pvc.metadata?.name ?? "",
        namespace: pvc.metadata?.namespace ?? IMAGE_NAMESPACE,
        capacity: pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage,
        storageClass: pvc.spec?.storageClassName ?? undefined,
      }))
      .filter((i) => i.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
