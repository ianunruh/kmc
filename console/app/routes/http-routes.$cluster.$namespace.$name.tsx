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
import type { Route } from "./+types/http-routes.$cluster.$namespace.$name";
import {
  ConfirmDeleteModal,
  DetailTabs,
  ResourceIdentity,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  detailTabPath,
  httpRouteEditPath,
  httpRoutePath,
  httpRoutesListPath,
} from "~/lib/format";
import { deleteHttpRoute, getHttpRoute } from "~/httproutes/httproutes.server";
import { membershipModeLabel } from "~/backends/membership";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "HTTP Route"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const route = await getHttpRoute(cluster, namespace, name);
  return { route };
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
    await deleteHttpRoute(cluster, namespace, name);
    return redirect("/http-routes");
  } catch (err) {
    return actionFailure("httproute.delete", err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

export default function HttpRouteDetailLayout({ loaderData }: Route.ComponentProps) {
  const { route } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const base = httpRoutePath(route);
  const parent = route.parentRefs[0];

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    } else if (data.ok) {
      notifyActionSuccess("Done", "HTTPRoute deleted");
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/http-routes" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              HTTP Routes
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {route.name}
            </Title>
            {route.backend?.membership && (
              <Badge variant="light" color="gray">
                {membershipModeLabel(route.backend.membership)}
              </Badge>
            )}
            {parent && (
              <Badge variant="light" color="gray">
                {parent.namespace && parent.namespace !== route.namespace
                  ? `${parent.namespace}/`
                  : ""}
                {parent.name}
              </Badge>
            )}
            {route.accepted === true && (
              <Badge variant="light" color="teal">
                Accepted
              </Badge>
            )}
            {route.accepted === false && (
              <Badge variant="light" color="orange">
                Not accepted
              </Badge>
            )}
            {route.endpointsTotal != null && (
              <Badge variant="light" color="gray">
                {route.endpointsReady ?? 0}/{route.endpointsTotal} endpoints
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            items={[
              { label: route.cluster, to: httpRoutesListPath({ cluster: route.cluster }) },
              {
                label: route.namespace,
                to: httpRoutesListPath({
                  cluster: route.cluster,
                  namespace: route.namespace,
                }),
              },
            ]}
          />
        </div>
        <Group gap="xs">
          <Button
            component={Link}
            to={httpRouteEditPath(route)}
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

      {route.vm && !route.vm.exists && (
        <Alert color="yellow" variant="light" title="Target VM missing">
          Bound VM <Code>{route.vm.name}</Code> was not found in this namespace.
          The Service may have empty endpoints.
        </Alert>
      )}
      {route.vm?.exists && !route.vm.podNetwork && (
        <Alert color="yellow" variant="light" title="Multus network">
          Target VM uses Multus. The companion Service selects the virt-launcher
          pod IP, not Multus guest addresses.
        </Alert>
      )}
      {(route.backend?.matchedVms ?? []).some((vm) => !vm.podNetwork) &&
        !(route.vm?.exists && !route.vm.podNetwork) && (
          <Alert color="yellow" variant="light" title="Multus members">
            One or more matched VMs are Multus-only. The Service selects
            virt-launcher pod IPs, not Multus guest addresses.
          </Alert>
        )}
      {route.backend?.exists &&
        (route.backend.matchedVms?.length ?? 0) === 0 && (
          <Alert color="yellow" variant="light" title="No matching VMs">
            No VMs currently match the Service selector. Group members may need
            a restart for labels to appear on virt-launcher pods.
          </Alert>
        )}
      {route.backend && !route.backend.exists && (
        <Alert color="red" variant="light" title="Companion Service missing">
          Expected Service{" "}
          <Code>
            {route.namespace}/{route.serviceName ?? route.name}
          </Code>
          . Recreate the HTTPRoute or restore the Service.
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
        resourceName={route.name}
        identity={`${route.cluster}/${route.namespace}/${route.name}`}
        title="Delete HTTP Route"
        confirmLabel="Delete HTTP Route"
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
