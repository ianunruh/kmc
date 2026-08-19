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
import type { Route } from "./+types/namespaces.$cluster.$name";
import {
  ConfirmDeleteModal,
  DetailTabs,
  ResourceIdentity,
} from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  detailTabPath,
  namespacePath,
  namespacesListPath,
} from "~/lib/format";
import { deleteNamespace, getNamespace } from "~/namespaces/namespaces.server";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Namespace"} · kmc` }];
}

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, name } = params;
  if (!cluster || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const ns = await getNamespace(cluster, name);
  return { ns };
});

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, name } = params;
  if (!cluster || !name) {
    return { ok: false, error: "Missing path params" };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "delete") {
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  }
  try {
    await deleteNamespace(cluster, name);
    return redirect("/namespaces");
  } catch (err) {
    return actionFailure("namespace.delete", err, {
      intent,
      cluster,
      name,
    });
  }
}

export default function NamespaceDetailLayout({ loaderData }: Route.ComponentProps) {
  const { ns } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const hasVms = ns.vmCount > 0;
  const base = namespacePath(ns);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/namespaces" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Namespaces
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {ns.name}
            </Title>
            <Badge
              variant="light"
              color={ns.phase === "Active" ? "teal" : "gray"}
            >
              {ns.phase}
            </Badge>
            {ns.managedByKmc && (
              <Badge variant="light" color="gray">
                kmc
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            separator=" · "
            items={[
              {
                label: ns.cluster,
                to: namespacesListPath({ cluster: ns.cluster }),
              },
              { label: "Namespace" },
            ]}
          />
        </div>
        <Group>
          <Button
            color="red"
            variant="light"
            leftSection={<IconTrash size={16} />}
            disabled={busy || hasVms}
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </Button>
        </Group>
      </Group>

      {hasVms && (
        <Alert color="yellow" variant="light" title="VMs present">
          Delete is blocked while {ns.vmCount} VirtualMachine(s) still exist in
          this namespace. Stop and delete those VMs first.
        </Alert>
      )}

      <DetailTabs
        items={[
          { label: "Overview", to: detailTabPath(base, "overview"), end: true },
          { label: "YAML", to: detailTabPath(base, "yaml") },
        ]}
      />

      <Outlet />

      <ConfirmDeleteModal
        opened={deleteOpen}
        resourceName={ns.name}
        identity={`${ns.cluster}/${ns.name}`}
        title="Delete Namespace"
        confirmLabel="Delete Namespace"
        warning="Deletes the Kubernetes Namespace and cascades namespaced resources. Blocked while VirtualMachines still exist."
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
