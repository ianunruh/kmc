import {
  Alert,
  Anchor,
  Button,
  Group,
  Stack,
  Title,
} from "@mantine/core";
import { IconArrowLeft, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link, Outlet, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/datavolumes.$cluster.$namespace.$name";
import { StatusBadge } from "~/ui/status-badge";
import {
  ConfirmDeleteModal,
  DetailTabs,
  ResourceIdentity,
  ResourceLink,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import { dataVolumePath, dataVolumesListPath, detailTabPath } from "~/lib/format";
import { deleteDataVolume, getDataVolume } from "~/datavolumes/datavolumes.server";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "DataVolume"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const dv = await getDataVolume(cluster, namespace, name);
  return { dv };
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
    await deleteDataVolume(cluster, namespace, name);
    return redirect("/datavolumes");
  } catch (err) {
    return actionFailure("datavolume.delete", err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

export default function DataVolumeDetailLayout({ loaderData }: Route.ComponentProps) {
  const { dv } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const base = dataVolumePath(dv);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    } else if (data.ok) {
      notifyActionSuccess("Done", "DataVolume deleted");
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/datavolumes" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Data Volumes
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {dv.name}
            </Title>
            <ResourceLink
              to={dataVolumesListPath({ cluster: dv.cluster, phase: dv.phase })}
              underline="never"
            >
              <StatusBadge status={dv.phase} />
            </ResourceLink>
          </Group>
          <ResourceIdentity
            items={[
              { label: dv.cluster, to: dataVolumesListPath({ cluster: dv.cluster }) },
              {
                label: dv.namespace,
                to: dataVolumesListPath({
                  cluster: dv.cluster,
                  namespace: dv.namespace,
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

      {dv.message && (
        <Alert color="yellow" variant="light" title="Status message">
          {dv.message}
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
        resourceName={dv.name}
        identity={`${dv.cluster}/${dv.namespace}/${dv.name}`}
        title="Delete data volume"
        confirmLabel="Delete DataVolume"
        warning="The backing PVC may also be removed."
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
