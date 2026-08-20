import { formatError } from "~/lib/errors";
import type { ClusterId, CreateVmRequest, VmSummary } from "~/lib/types";
import { getRequestSession } from "~/lib/auth/middleware.server";
import { getClusterClients } from "~/lib/k8s/clients.server";
import { getImageNamespace, listReadyImages } from "~/lib/k8s/image-catalog.server";
import { getClusterCatalog, getImagePreference } from "~/lib/k8s/catalog.server";
import {
  KMC_ANN_REPO,
  KMC_ANN_WORKSPACE_PATH,
  KMC_LABEL_RESOURCE,
  KMC_LABEL_TEMPLATE,
  KMC_MANAGED_BY,
  KMC_RESOURCE_DEVBOX,
  MANAGED_BY_LABEL,
} from "~/lib/k8s/constants";
import { preferredInstanceTypeName } from "~/instancetypes/options";
import {
  getConsoleSshUser,
  getPlatformConsolePublicKey,
} from "~/vms/console-ssh-key.server";
import { cloudInitUserDataSecretName } from "~/vms/template.server";
import {
  buildCloudInitDocument,
  parseHttpsGitUrl,
  workspacePathForRepo,
} from "~/vms/cloud-init";
import { createVm, deleteVm, listVms } from "~/vms/vms.server";
import {
  deleteDevBoxCompanions,
  ensureDevBoxIdeRoute,
  ensureDevBoxSshLoadBalancer,
} from "./access.server";
import { DEVBOX_TEMPLATES, isDevBoxTemplateId, type DevBoxTemplateId } from "./options";

export type CreateDevBoxRequest = {
  cluster: ClusterId;
  namespace: string;
  name: string;
  template: DevBoxTemplateId;
  instanceType?: string;
  diskSize?: string;
  storageClass?: string;
  sshPublicKey: string;
  repoUrl?: string;
};

export function resolveDevBoxImage(images: Array<{ name: string; namespace: string }>): {
  namespace: string;
  name: string;
} {
  const configured = process.env.KMC_DEVBOX_IMAGE?.trim();
  if (configured) {
    const [ns, name] = configured.includes("/")
      ? (configured.split("/") as [string, string])
      : [getImageNamespace(), configured];
    const match = images.find((i) => i.namespace === ns && i.name === name);
    if (!match) {
      throw new Error(
        `KMC_DEVBOX_IMAGE "${configured}" is not a ready golden image. Import it under Images.`,
      );
    }
    return { namespace: match.namespace, name: match.name };
  }
  const ubuntu = images.find((i) => i.name.toLowerCase().includes("ubuntu"));
  const pick = ubuntu ?? images[0];
  if (!pick) {
    throw new Error(
      "No ready golden images found. Import an Ubuntu cloud image under Images.",
    );
  }
  return { namespace: pick.namespace, name: pick.name };
}

export async function listDevBoxes(clusterFilter?: ClusterId): Promise<{
  items: VmSummary[];
  clusters: Awaited<ReturnType<typeof listVms>>["clusters"];
}> {
  const { items, clusters } = await listVms(clusterFilter);
  return {
    items: items.filter((vm) => vm.resource === KMC_RESOURCE_DEVBOX),
    clusters,
  };
}

async function writeUserDataSecret(input: {
  cluster: ClusterId;
  namespace: string;
  name: string;
  userdata: string;
}): Promise<string> {
  const secretName = cloudInitUserDataSecretName(input.name);
  const { core } = getClusterClients(input.cluster);
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
            [KMC_LABEL_RESOURCE]: KMC_RESOURCE_DEVBOX,
          },
        },
        type: "Opaque",
        stringData: { userdata: input.userdata },
      },
    });
  } catch (err) {
    throw new Error(`Failed to create cloud-init Secret: ${formatError(err)}`, {
      cause: err,
    });
  }
  return secretName;
}

async function deleteUserDataSecret(
  cluster: ClusterId,
  namespace: string,
  vmName: string,
): Promise<void> {
  const { core } = getClusterClients(cluster);
  try {
    await core.deleteNamespacedSecret({
      name: cloudInitUserDataSecretName(vmName),
      namespace,
    });
  } catch {
    /* ignore */
  }
}

export async function createDevBox(input: CreateDevBoxRequest): Promise<VmSummary> {
  if (!isDevBoxTemplateId(input.template)) {
    throw new Error(`Unknown Dev Box template: ${input.template}`);
  }
  const tmpl = DEVBOX_TEMPLATES[input.template];
  const sshUser = getConsoleSshUser();
  const session = getRequestSession();
  const repoUrl = input.repoUrl?.trim() || undefined;
  if (repoUrl) parseHttpsGitUrl(repoUrl);

  const [images, catalog] = await Promise.all([
    listReadyImages(input.cluster),
    getClusterCatalog(input.cluster),
  ]);
  const image = resolveDevBoxImage(images);
  const preference = await getImagePreference(input.cluster, image.namespace, image.name);
  const instanceType =
    input.instanceType?.trim() || preferredInstanceTypeName(catalog.instanceTypes);
  if (!instanceType) {
    throw new Error("No instance type available — create one or pick a size");
  }

  const platformPub = await getPlatformConsolePublicKey();
  const userdata = buildCloudInitDocument({
    sshPublicKeys: [input.sshPublicKey, ...(platformPub ? [platformPub] : [])],
    sshUser,
    guestAgent: true,
    traceroute: true,
    basePackages: true,
    docker: tmpl.docker,
    gitIdentity: session?.user
      ? {
          name: session.user.name,
          email: session.user.email,
          githubLogin: session.user.githubLogin,
        }
      : undefined,
    repoUrl,
    codeServer: tmpl.codeServer,
    readyFile: true,
  });

  const secretName = await writeUserDataSecret({
    cluster: input.cluster,
    namespace: input.namespace,
    name: input.name,
    userdata,
  });

  const annotations: Record<string, string> = {};
  if (repoUrl) {
    annotations[KMC_ANN_REPO] = repoUrl;
    annotations[KMC_ANN_WORKSPACE_PATH] = workspacePathForRepo(sshUser, repoUrl);
  }

  const payload: CreateVmRequest = {
    cluster: input.cluster,
    namespace: input.namespace,
    name: input.name,
    instanceType,
    diskSize: input.diskSize?.trim() || tmpl.defaultDiskSize,
    storageClass: input.storageClass,
    image: { kind: "pvc", namespace: image.namespace, name: image.name },
    preference,
    sshPublicKey: input.sshPublicKey,
    start: true,
    installGuestAgent: true,
    includePodNetwork: true,
    labels: {
      [KMC_LABEL_RESOURCE]: KMC_RESOURCE_DEVBOX,
      [KMC_LABEL_TEMPLATE]: tmpl.id,
    },
    annotations,
    userDataSecretName: secretName,
  };

  let created: VmSummary | undefined;
  try {
    created = await createVm(payload);
  } catch (err) {
    await deleteUserDataSecret(input.cluster, input.namespace, input.name);
    throw err;
  }

  try {
    await ensureDevBoxSshLoadBalancer({
      cluster: input.cluster,
      namespace: input.namespace,
      vmName: input.name,
    });
    if (tmpl.codeServer) {
      const ide = await ensureDevBoxIdeRoute({
        cluster: input.cluster,
        namespace: input.namespace,
        vmName: input.name,
      });
      if ("skipped" in ide) {
        console.warn(`createDevBox IDE skipped: ${ide.skipped}`);
      }
    }
  } catch (err) {
    try {
      await deleteDevBox(input.cluster, input.namespace, input.name);
    } catch {
      /* keep original */
    }
    throw new Error(
      `Dev Box VM created but access companions failed: ${formatError(err)}`,
      { cause: err },
    );
  }

  return created;
}

export async function deleteDevBox(
  cluster: ClusterId,
  namespace: string,
  name: string,
): Promise<void> {
  await deleteDevBoxCompanions(cluster, namespace, name);
  await deleteUserDataSecret(cluster, namespace, name);
  await deleteVm(cluster, namespace, name);
}
