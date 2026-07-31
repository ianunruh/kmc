import {
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
import type { Route } from "./+types/object-storage.$cluster.$namespace.$name";
import { StatusBadge } from "~/ui/status-badge";
import {
  ConfirmDeleteModal,
  DetailTabs,
  ResourceIdentity,
  ResourceLink,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  detailTabPath,
  objectStorageListPath,
  objectStoragePath,
} from "~/lib/format";
import {
  deleteObjectBucket,
  getObjectBucket,
} from "~/object-storage/object-storage.server";
import { getClusterObjectStorageEndpoint } from "~/lib/k8s/cluster-config.server";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Object Bucket"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const bucket = await getObjectBucket(cluster, namespace, name);
  return {
    bucket,
    externalEndpoint: getClusterObjectStorageEndpoint(cluster),
  };
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
    await deleteObjectBucket(cluster, namespace, name);
    return redirect("/object-storage");
  } catch (err) {
    return actionFailure("object-storage.delete", err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

export default function ObjectStorageDetailLayout({
  loaderData,
}: Route.ComponentProps) {
  const { bucket } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const base = objectStoragePath(bucket);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    } else if (data.ok) {
      notifyActionSuccess("Done", "Object bucket claim deleted");
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/object-storage" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Object Storage
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {bucket.name}
            </Title>
            <ResourceLink
              to={objectStorageListPath({
                cluster: bucket.cluster,
                status: bucket.status,
              })}
              underline="never"
            >
              <StatusBadge status={bucket.status} />
            </ResourceLink>
            {bucket.managedByKmc ? (
              <Badge size="sm" variant="light" color="accent">
                kmc
              </Badge>
            ) : (
              <Badge size="sm" variant="outline" color="gray">
                external
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            items={[
              {
                label: bucket.cluster,
                to: objectStorageListPath({ cluster: bucket.cluster }),
              },
              {
                label: bucket.namespace,
                to: objectStorageListPath({
                  cluster: bucket.cluster,
                  namespace: bucket.namespace,
                }),
              },
            ]}
          />
        </div>
        <Group gap="xs" wrap="wrap" justify="flex-end">
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

      <DetailTabs
        items={[
          { label: "Overview", to: detailTabPath(base, "overview"), end: true },
          { label: "Access", to: detailTabPath(base, "access") },
          { label: "Events", to: detailTabPath(base, "events") },
          { label: "YAML", to: detailTabPath(base, "yaml") },
        ]}
      />

      <Outlet />

      <ConfirmDeleteModal
        opened={deleteOpen}
        resourceName={bucket.name}
        identity={`${bucket.cluster}/${bucket.namespace}/${bucket.name}`}
        title="Delete object bucket"
        confirmLabel="Delete claim"
        warning={
          bucket.managedByKmc
            ? "Deletes the ObjectBucketClaim and typically the underlying S3 bucket. Data will be lost."
            : "This claim was not created by kmc. Deleting removes the ObjectBucketClaim and typically the underlying S3 bucket — data will be lost."
        }
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
