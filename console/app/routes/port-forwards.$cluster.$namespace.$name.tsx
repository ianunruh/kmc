import { Badge, Button, Group, Stack, Title } from "@mantine/core";
import { IconArrowLeft, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link, Outlet, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/port-forwards.$cluster.$namespace.$name";
import {
  ConfirmDeleteModal,
  DetailTabs,
  ResourceIdentity,
  StatusBadge,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  detailTabPath,
  portForwardPath,
  portForwardsListPath,
} from "~/lib/format";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { deletePortForward, getPortForward } from "~/vpcs/vpcs.server";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Port Forward"} · Port Forward · kmc` }];
}

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const pf = await getPortForward(cluster, namespace, name);
  return { pf };
});

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing path params" };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "delete") {
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  }
  try {
    const pf = await getPortForward(cluster, namespace, name);
    await deletePortForward({
      cluster,
      namespace,
      vpcName: pf.vpcName,
      id: pf.name,
    });
    return redirect(portForwardsListPath());
  } catch (err) {
    return actionFailure("portForward.delete", err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

export default function PortForwardDetailLayout({
  loaderData,
}: Route.ComponentProps) {
  const { pf } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const base = portForwardPath({
    cluster: pf.cluster,
    namespace: pf.namespace,
    name: pf.name,
  });

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    } else if (data.ok) {
      notifyActionSuccess("Done", "Port forward deleted");
    }
  });

  const displayTitle = pf.public
    ? `${pf.public}:${pf.publicPort}`
    : pf.name;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Button
            component={Link}
            to={portForwardsListPath()}
            variant="subtle"
            size="compact-sm"
            leftSection={<IconArrowLeft size={14} />}
            mb="xs"
          >
            Port Forwards
          </Button>
          <Group gap="sm" mb={4}>
            <Title order={2}>{displayTitle}</Title>
            <Badge size="sm" variant="light" color="blue">
              {pf.protocol.toUpperCase()}
            </Badge>
            {pf.phase ? <StatusBadge status={pf.phase} /> : null}
          </Group>
          <ResourceIdentity
            items={[
              {
                label: pf.cluster,
                to: portForwardsListPath({ cluster: pf.cluster }),
              },
              {
                label: pf.namespace,
                to: portForwardsListPath({
                  cluster: pf.cluster,
                  namespace: pf.namespace,
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

      <DetailTabs
        items={[
          { label: "Overview", to: detailTabPath(base, "overview"), end: true },
          { label: "Events", to: detailTabPath(base, "events") },
          { label: "YAML", to: detailTabPath(base, "yaml") },
        ]}
      />

      <Outlet />

      <ConfirmDeleteModal
        opened={deleteOpen}
        resourceName={displayTitle}
        identity={`${pf.cluster}/${pf.namespace}/${pf.name}`}
        title="Delete port forward"
        confirmLabel="Delete port forward"
        loading={busy}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteOpen(false);
          fetcher.submit({ intent: "delete" }, { method: "post" });
        }}
      />
    </Stack>
  );
}
