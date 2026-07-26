import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Stack,
  Title,
} from "@mantine/core";
import { IconArrowLeft, IconPencil, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link, Outlet, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/ingresses.$cluster.$namespace.$name";
import {
  ConfirmDeleteModal,
  DetailTabs,
  ResourceIdentity,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  detailTabPath,
  ingressEditPath,
  ingressPath,
  ingressesListPath,
} from "~/lib/format";
import { deleteIngress, getIngress } from "~/ingresses/ingresses.server";
import { membershipModeLabel } from "~/backends/membership";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Ingress"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const ing = await getIngress(cluster, namespace, name);
  return { ing };
}

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
    await deleteIngress(cluster, namespace, name);
    return redirect("/ingresses");
  } catch (err) {
    return actionFailure("ingress.delete", err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

export default function IngressDetailLayout({ loaderData }: Route.ComponentProps) {
  const { ing } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const base = ingressPath(ing);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    } else if (data.ok) {
      notifyActionSuccess("Done", "Ingress deleted");
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/ingresses" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Ingresses
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {ing.name}
            </Title>
            {ing.backend?.membership && (
              <Badge variant="light" color="gray">
                {membershipModeLabel(ing.backend.membership)}
              </Badge>
            )}
            {ing.className && (
              <Badge variant="light" color="gray">
                {ing.className}
              </Badge>
            )}
            {ing.endpointsTotal != null && (
              <Badge variant="light" color="gray">
                {ing.endpointsReady ?? 0}/{ing.endpointsTotal} endpoints
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            items={[
              { label: ing.cluster, to: ingressesListPath({ cluster: ing.cluster }) },
              {
                label: ing.namespace,
                to: ingressesListPath({
                  cluster: ing.cluster,
                  namespace: ing.namespace,
                }),
              },
            ]}
          />
        </div>
        <Group gap="xs">
          <Button
            component={Link}
            to={ingressEditPath(ing)}
            variant="light"
            leftSection={<IconPencil size={16} />}
          >
            Edit
          </Button>
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
      </Group>

      {ing.vm && !ing.vm.exists && (
        <Alert color="yellow" variant="light" title="Target VM missing">
          Bound VM <Code>{ing.vm.name}</Code> was not found in this namespace.
          The Service may have empty endpoints.
        </Alert>
      )}
      {ing.vm?.exists && !ing.vm.podNetwork && (
        <Alert color="yellow" variant="light" title="Multus network">
          Target VM uses Multus. The companion Service selects the virt-launcher
          pod IP, not Multus guest addresses.
        </Alert>
      )}
      {(ing.backend?.matchedVms ?? []).some((vm) => !vm.podNetwork) &&
        !(ing.vm?.exists && !ing.vm.podNetwork) && (
          <Alert color="yellow" variant="light" title="Multus members">
            One or more matched VMs are Multus-only. The Service selects
            virt-launcher pod IPs, not Multus guest addresses.
          </Alert>
        )}
      {ing.backend?.exists &&
        (ing.backend.matchedVms?.length ?? 0) === 0 && (
          <Alert color="yellow" variant="light" title="No matching VMs">
            No VMs currently match the Service selector. Group members may need
            a restart for labels to appear on virt-launcher pods.
          </Alert>
        )}
      {ing.backend && !ing.backend.exists && (
        <Alert color="red" variant="light" title="Companion Service missing">
          Expected Service{" "}
          <Code>
            {ing.namespace}/{ing.serviceName ?? ing.name}
          </Code>
          . Recreate the Ingress or restore the Service.
        </Alert>
      )}

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
        resourceName={ing.name}
        identity={`${ing.cluster}/${ing.namespace}/${ing.name}`}
        title="Delete Ingress"
        confirmLabel="Delete Ingress"
        warning="Also deletes the companion ClusterIP Service with the same name. Group membership labels are cleared. VirtualMachines are not deleted."
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
