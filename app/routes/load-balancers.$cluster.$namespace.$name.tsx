import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Stack,
  Title,
} from "@mantine/core";
import { IconArrowLeft, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link, Outlet, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/load-balancers.$cluster.$namespace.$name";
import {
  ConfirmDeleteModal,
  DetailTabs,
  ResourceIdentity,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  detailTabPath,
  loadBalancerPath,
  loadBalancersListPath,
} from "~/lib/format";
import {
  deleteLoadBalancer,
  getLoadBalancer,
} from "~/backends/backends.server";
import { membershipModeLabel } from "~/backends/membership";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Load balancer"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const lb = await getLoadBalancer(cluster, namespace, name);
  return { lb };
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
    await deleteLoadBalancer(cluster, namespace, name);
    return redirect("/load-balancers");
  } catch (err) {
    return actionFailure("loadbalancer.delete", err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

export default function LoadBalancerDetailLayout({
  loaderData,
}: Route.ComponentProps) {
  const { lb } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const base = loadBalancerPath(lb);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    } else if (data.ok) {
      notifyActionSuccess("Done", "Load balancer deleted");
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/load-balancers" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Load Balancers
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {lb.name}
            </Title>
            <Badge variant="light" color="teal">
              LoadBalancer
            </Badge>
            <Badge variant="light" color="gray">
              {membershipModeLabel(lb.membership)}
            </Badge>
            {lb.externalAddress ? (
              <Badge variant="light" color="green">
                {lb.externalAddress}
              </Badge>
            ) : (
              <Badge variant="light" color="yellow">
                VIP pending
              </Badge>
            )}
            {lb.endpointsTotal != null && (
              <Badge variant="light" color="gray">
                {lb.endpointsReady ?? 0}/{lb.endpointsTotal} endpoints
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            items={[
              {
                label: lb.cluster,
                to: loadBalancersListPath({ cluster: lb.cluster }),
              },
              {
                label: lb.namespace,
                to: loadBalancersListPath({
                  cluster: lb.cluster,
                  namespace: lb.namespace,
                }),
              },
            ]}
          />
        </div>
        <Button
          color="red"
          variant="light"
          leftSection={<IconTrash size={16} />}
          onClick={() => setDeleteOpen(true)}
          loading={busy}
        >
          Delete
        </Button>
      </Group>

      {!lb.externalAddress && (
        <Alert color="yellow" variant="light" title="External address pending">
          No VIP in <code>status.loadBalancer</code> yet. Ensure MetalLB (or
          another LoadBalancer controller) is installed and has free IPs.
        </Alert>
      )}
      {lb.matchedVms.some((vm) => !vm.podNetwork) && (
        <Alert color="yellow" variant="light" title="Multus members">
          One or more matched VMs are Multus-only. The Service still selects
          virt-launcher pod IPs, not Multus guest addresses.
        </Alert>
      )}
      {lb.matchedVms.length === 0 && (
        <Alert color="yellow" variant="light" title="No matching VMs">
          No VMs currently match the Service selector. Group members may need a
          restart for labels to appear on virt-launcher pods.
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
        resourceName={lb.name}
        identity={`${lb.cluster}/${lb.namespace}/${lb.name}`}
        title="Delete load balancer"
        confirmLabel="Delete"
        warning="Deletes the LoadBalancer Service. Group membership labels are cleared. VirtualMachines are not deleted."
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
