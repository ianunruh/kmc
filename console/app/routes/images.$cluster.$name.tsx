import { Alert, Anchor, Button, Group, Stack, Title } from "@mantine/core";
import { IconArrowLeft, IconPencil, IconRocket, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link, Outlet, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/images.$cluster.$name";
import { StatusBadge } from "~/ui/status-badge";
import { ConfirmDeleteModal, DetailTabs, ResourceIdentity, ResourceLink } from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  detailTabPath,
  imageEditPath,
  imagePath,
  imagesListPath,
  vmCreateFromImagePath,
} from "~/lib/format";
import { deleteImage, getImage } from "~/images/images.server";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Image"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, name } = params;
  if (!cluster || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const image = await getImage(cluster, name);
  return { image };
}

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
    await deleteImage(cluster, name);
    return redirect("/images");
  } catch (err) {
    return actionFailure("image.delete", err, {
      intent,
      cluster,
      name,
    });
  }
}

export default function ImageDetailLayout({ loaderData }: Route.ComponentProps) {
  const { image } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const base = imagePath(image);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/images" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Images
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {image.name}
            </Title>
            <ResourceLink
              to={imagesListPath({ cluster: image.cluster, phase: image.phase })}
              underline="never"
            >
              <StatusBadge status={image.phase} />
            </ResourceLink>
          </Group>
          <ResourceIdentity
            items={[
              { label: image.cluster, to: imagesListPath({ cluster: image.cluster }) },
              { label: image.namespace },
            ]}
          />
        </div>
        <Group gap="sm">
          <Button
            component={Link}
            to={imageEditPath(image)}
            leftSection={<IconPencil size={16} />}
            variant="light"
          >
            Edit
          </Button>
          {image.ready && (
            <Button
              component={Link}
              to={vmCreateFromImagePath(image)}
              leftSection={<IconRocket size={16} />}
              variant="light"
            >
              Launch VM
            </Button>
          )}
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

      {image.message && (
        <Alert color="yellow" variant="light" title="Status message">
          {image.message}
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
        resourceName={image.name}
        identity={`${image.cluster}/${image.namespace}/${image.name}`}
        title="Delete image"
        confirmLabel="Delete image"
        warning="Deletes the DataVolume and backing PVC. Existing VMs that cloned this image are not affected."
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
