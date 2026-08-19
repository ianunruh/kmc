import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, Outlet, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/vpcs.$cluster.$namespace.$name";
import {
  ConfirmDeleteModal,
  DetailTabs,
  ResourceIdentity,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  detailTabPath,
  vpcEditPath,
  vpcPath,
  vpcsListPath,
} from "~/lib/format";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import {
  deletePortForward,
  deleteVpc,
  disassociateFloatingIp,
  getVpc,
  releaseFloatingIp,
} from "~/vpcs/vpcs.server";
import {
  attachRouterVpc,
  listRoutersForVpcAttach,
} from "~/vpcs/routers.server";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "VPC"} · kmc` }];
}

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const vpc = await getVpc(cluster, namespace, name);
  let attachableRouters: Awaited<ReturnType<typeof listRoutersForVpcAttach>> =
    [];
  if (vpc.cidr && !vpc.router) {
    try {
      attachableRouters = await listRoutersForVpcAttach(
        cluster,
        namespace,
        name,
      );
    } catch {
      attachableRouters = [];
    }
  }
  return { vpc, attachableRouters };
});

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing path params" };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "delete") {
    try {
      await deleteVpc(cluster, namespace, name);
      return redirect("/vpcs");
    } catch (err) {
      return actionFailure("vpc.delete", err, {
        intent,
        cluster,
        namespace,
        name,
      });
    }
  }
  if (intent === "attach-router") {
    const routerName = String(form.get("routerName") ?? "").trim();
    if (!routerName) {
      return { ok: false, error: "Select a router", intent };
    }
    try {
      const result = await attachRouterVpc({
        cluster,
        namespace,
        routerName,
        vpcName: name,
      });
      return {
        ok: true,
        intent: "attach-router",
        restarted: result.restarted,
      };
    } catch (err) {
      return actionFailure("vpc.attachRouter", err, {
        intent,
        cluster,
        namespace,
        name,
        routerName,
      });
    }
  }
  if (intent === "disassociate" || intent === "release") {
    const idOrPublic = String(form.get("idOrPublic") ?? "").trim();
    if (!idOrPublic) {
      return { ok: false, error: "Missing floating IP id", intent };
    }
    try {
      if (intent === "disassociate") {
        await disassociateFloatingIp({
          cluster,
          namespace,
          vpcName: name,
          idOrPublic,
        });
      } else {
        await releaseFloatingIp({
          cluster,
          namespace,
          vpcName: name,
          idOrPublic,
        });
      }
      return { ok: true, intent };
    } catch (err) {
      return actionFailure(`floatingIp.${intent}`, err, {
        intent,
        cluster,
        namespace,
        name,
        idOrPublic,
      });
    }
  }
  if (intent === "delete-port-forward") {
    const id = String(form.get("id") ?? "").trim();
    if (!id) {
      return { ok: false, error: "Missing port forward id", intent };
    }
    try {
      await deletePortForward({
        cluster,
        namespace,
        vpcName: name,
        id,
      });
      return { ok: true, intent };
    } catch (err) {
      return actionFailure("portForward.delete", err, {
        intent,
        cluster,
        namespace,
        name,
        id,
      });
    }
  }
  return { ok: false, error: `Unknown intent: ${intent}`, intent };
}

export default function VpcDetailLayout({ loaderData }: Route.ComponentProps) {
  const { vpc } = loaderData;
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string;
    intent?: string;
  }>();
  const { refreshNow } = useRefresh();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const hasAttachments = vpc.attachedCount > 0;
  const base = vpcPath(vpc);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      const title =
        data.intent === "disassociate"
          ? "Disassociate failed"
          : data.intent === "release"
            ? "Release failed"
            : data.intent === "delete-port-forward"
              ? "Delete port forward failed"
              : data.intent === "attach-router"
                ? "Attach router failed"
                : "Delete failed";
      notifyActionError(title, data.error);
    } else if (data.ok) {
      if (data.intent === "disassociate") {
        notifyActionSuccess(
          "Done",
          "Floating IP disassociated — public address is held (not released)",
        );
        refreshNow();
      } else if (data.intent === "release") {
        notifyActionSuccess(
          "Done",
          "Floating IP released — public address returned to the pool",
        );
        refreshNow();
      } else if (data.intent === "delete-port-forward") {
        notifyActionSuccess("Done", "Port forward deleted");
        refreshNow();
      } else if (data.intent === "attach-router") {
        notifyActionSuccess(
          "Done",
          (data as { restarted?: boolean }).restarted
            ? "Router attached — appliance restarted so the Multus NIC could land"
            : "Router attached",
        );
        refreshNow();
      } else {
        notifyActionSuccess("Done", "VPC deleted");
      }
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/vpcs" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              VPCs
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {vpc.name}
            </Title>
            <Badge variant="light" color="accent" ff="monospace">
              VLAN {vpc.vlan}
            </Badge>
            {vpc.cidr ? (
              <Badge variant="light" color="gray">
                IPAM
              </Badge>
            ) : (
              <Badge variant="light" color="gray">
                L2 only
              </Badge>
            )}
            {vpc.router && (
              <Badge variant="light" color="violet">
                Router
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            items={[
              { label: vpc.cluster, to: vpcsListPath({ cluster: vpc.cluster }) },
              {
                label: vpc.namespace,
                to: vpcsListPath({
                  cluster: vpc.cluster,
                  namespace: vpc.namespace,
                }),
              },
            ]}
          />
        </div>
        <Group gap="sm">
          <Button
            component={Link}
            to={vpcEditPath(vpc)}
            variant="default"
            leftSection={<IconPencil size={16} />}
          >
            Edit
          </Button>
          <Button
            color="red"
            variant="light"
            leftSection={<IconTrash size={16} />}
            disabled={busy || hasAttachments}
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </Button>
        </Group>
      </Group>

      {hasAttachments && (
        <Alert color="yellow" variant="light" title="VMs attached">
          Delete is blocked while {vpc.attachedCount} VM(s) still use this Multus network.
          Stop and delete or re-attach those VMs first.
        </Alert>
      )}

      {vpc.description && (
        <Text size="sm" c="dimmed">
          {vpc.description}
        </Text>
      )}

      <DetailTabs
        items={[
          { label: "Overview", to: detailTabPath(base, "overview"), end: true },
          { label: "Attached VMs", to: detailTabPath(base, "vms") },
          { label: "Events", to: detailTabPath(base, "events") },
          { label: "YAML", to: detailTabPath(base, "yaml") },
        ]}
      />

      <Outlet />

      <ConfirmDeleteModal
        opened={deleteOpen}
        resourceName={vpc.name}
        identity={`${vpc.cluster}/${vpc.namespace}/${vpc.name}`}
        title="Delete VPC"
        confirmLabel="Delete VPC"
        warning="Deletes the Multus NetworkAttachmentDefinition and frees the VLAN for reallocation."
        loading={busy}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit({ intent: "delete" }, { method: "post" });
          setDeleteOpen(false);
        }}
      />
    </Stack>
  );
}
