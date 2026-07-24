import {
  Alert,
  Badge,
  Button,
  Group,
  Stack,
  Title,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, Outlet, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/routers.$cluster.$namespace.$name";
import {
  ConfirmDeleteModal,
  DetailTabs,
  ResourceIdentity,
  StatusBadge,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { getRequestSession } from "~/lib/auth/middleware.server";
import { actionFailure } from "~/lib/errors";
import {
  detailTabPath,
  routerPath,
  routersListPath,
} from "~/lib/format";
import { getClusterCatalog } from "~/lib/k8s/catalog.server";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { listSshKeysOrEmpty } from "~/ssh-keys/ssh-keys.server";
import {
  deleteRouter,
  getRouter,
  recreateRouterVm,
  setRouterExternalGateway,
} from "~/vpcs/routers.server";
import { listPublicEgressNetworks } from "~/vpcs/vpcs.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Router"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const router = await getRouter(cluster, namespace, name);
  const publicNetworks = listPublicEgressNetworks(cluster);
  const session = getRequestSession();
  const { keys: sshKeys } = await listSshKeysOrEmpty(session?.user ?? null);

  let catalog: Awaited<ReturnType<typeof getClusterCatalog>> | null = null;
  let catalogError: string | null = null;
  if (router.vmMissing) {
    try {
      catalog = await getClusterCatalog(cluster);
    } catch (err) {
      catalogError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    router,
    publicNetworks,
    catalog,
    catalogError,
    sshKeys: sshKeys.map((k) => ({
      id: k.id,
      name: k.name,
      publicKey: k.publicKey,
      fingerprint: k.fingerprint,
    })),
    signedIn: Boolean(session?.user),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing path params" };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "delete") {
    try {
      await deleteRouter(cluster, namespace, name);
      return redirect("/routers");
    } catch (err) {
      return actionFailure("router.delete", err, { cluster, namespace, name });
    }
  }
  if (intent === "set-external") {
    try {
      const publicMultusNetwork = String(
        form.get("publicMultusNetwork") ?? "",
      ).trim();
      const sshPublicKey = await resolveSshPublicKey(form);
      await setRouterExternalGateway({
        cluster,
        namespace,
        routerName: name,
        publicMultusNetwork,
        sshPublicKey,
      });
      return { ok: true, intent: "set-external" };
    } catch (err) {
      return actionFailure("router.setExternal", err, {
        cluster,
        namespace,
        name,
      });
    }
  }
  if (intent === "recreate-vm") {
    try {
      const sshPublicKey = await resolveSshPublicKey(form);
      const imageValue = String(form.get("image") ?? "").trim();
      const diskSize = String(form.get("diskSize") ?? "").trim() || "10Gi";
      const storageClass =
        String(form.get("storageClass") ?? "").trim() || undefined;
      const sizeMode = String(form.get("sizeMode") ?? "manual").trim();
      const instanceType =
        String(form.get("instanceType") ?? "").trim() || undefined;
      const cpuCoresRaw = String(form.get("cpuCores") ?? "").trim();
      const memory = String(form.get("memory") ?? "").trim() || undefined;

      if (!imageValue) {
        return { ok: false, error: "Image is required to recreate the appliance" };
      }
      const [imageNamespace, imageName] = imageValue.includes("/")
        ? (imageValue.split("/") as [string, string])
        : ["vm-images", imageValue];

      const base = {
        cluster,
        namespace,
        routerName: name,
        sshPublicKey,
        diskSize,
        storageClass,
        image: {
          kind: "pvc" as const,
          namespace: imageNamespace,
          name: imageName,
        },
      };

      if (sizeMode === "instancetype" && instanceType) {
        await recreateRouterVm({ ...base, instanceType });
      } else {
        const cpuCores = Number(cpuCoresRaw || 1);
        if (!Number.isFinite(cpuCores) || cpuCores < 1) {
          return { ok: false, error: "CPU cores must be a positive number" };
        }
        if (!memory) {
          return { ok: false, error: "Memory is required" };
        }
        await recreateRouterVm({ ...base, cpuCores, memory });
      }
      return { ok: true, intent: "recreate-vm" };
    } catch (err) {
      return actionFailure("router.recreateVm", err, {
        cluster,
        namespace,
        name,
      });
    }
  }
  return { ok: false, error: `Unknown intent: ${intent}` };
}

async function resolveSshPublicKey(form: FormData): Promise<string> {
  let sshPublicKey = String(form.get("sshPublicKey") ?? "").trim();
  const sshKeyMode = String(form.get("sshKeyMode") ?? "paste").trim();
  const savedSshKeyId = String(form.get("savedSshKeyId") ?? "").trim();
  if (sshKeyMode === "saved" && savedSshKeyId) {
    const session = getRequestSession();
    if (!session?.user) {
      throw new Error("Sign in to use a saved SSH key");
    }
    const { keys } = await listSshKeysOrEmpty(session.user);
    const match = keys.find((k) => k.id === savedSshKeyId);
    if (!match) throw new Error("Saved SSH key not found");
    sshPublicKey = match.publicKey;
  }
  if (!sshPublicKey) throw new Error("SSH public key is required");
  return sshPublicKey;
}

export default function RouterDetailLayout({ loaderData }: Route.ComponentProps) {
  const { router } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const { refreshNow } = useRefresh();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const base = routerPath(router);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error);
      return;
    }
    if (data.ok) {
      if (data.intent === "set-external") {
        notifyActionSuccess("Done", "External gateway updated");
      } else if (data.intent === "recreate-vm") {
        notifyActionSuccess("Done", "Appliance VM recreate requested");
      } else {
        notifyActionSuccess("Done", "Router deleted");
      }
      refreshNow();
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Button
            component={Link}
            to={routersListPath()}
            variant="subtle"
            size="compact-sm"
            leftSection={<IconArrowLeft size={14} />}
            mb="xs"
          >
            Routers
          </Button>
          <Group gap="sm" mb={4}>
            <Title order={2}>{router.name}</Title>
            {router.agentStatus && <StatusBadge status={router.agentStatus} />}
            {router.hasExternal && (
              <Badge variant="light" color="teal">
                External
              </Badge>
            )}
            {router.vmMissing && (
              <Badge variant="light" color="orange">
                VM missing
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            items={[
              {
                label: router.cluster,
                to: routersListPath({ cluster: router.cluster }),
              },
              {
                label: router.namespace,
                to: routersListPath({
                  cluster: router.cluster,
                  namespace: router.namespace,
                }),
              },
            ]}
          />
        </div>
        <Button
          color="red"
          variant="light"
          leftSection={<IconTrash size={16} />}
          disabled={busy}
          onClick={() => setDeleteOpen(true)}
        >
          Delete
        </Button>
      </Group>

      {router.vmMissing && (
        <Alert color="orange" variant="light" title="Appliance VM missing">
          The router policy (leases, floating IPs, interfaces) is still here, but the
          VirtualMachine was deleted. Recreate the appliance below — do not create a
          new router with the same name (policy already exists).
        </Alert>
      )}

      <DetailTabs
        items={[
          { label: "Overview", to: detailTabPath(base, "overview"), end: true },
          { label: "DHCP leases", to: detailTabPath(base, "leases") },
          { label: "YAML", to: detailTabPath(base, "yaml") },
        ]}
      />

      <Outlet />

      <ConfirmDeleteModal
        opened={deleteOpen}
        resourceName={router.name}
        identity={`${router.cluster}/${router.namespace}/${router.name}`}
        title="Delete router"
        confirmLabel="Delete router"
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit({ intent: "delete" }, { method: "post" });
          setDeleteOpen(false);
        }}
      />
    </Stack>
  );
}
