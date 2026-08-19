import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Stack,
  Title,
} from "@mantine/core";
import { IconArrowLeft, IconPencil, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link, Outlet, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/instancetypes.$cluster.$name";
import {
  ConfirmDeleteModal,
  DetailTabs,
  ResourceIdentity,
} from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  detailTabPath,
  instanceTypeEditPath,
  instanceTypePath,
  instanceTypesListPath,
} from "~/lib/format";
import {
  deleteClusterInstanceType,
  getClusterInstanceType,
} from "~/instancetypes/instancetypes.server";
import { instanceTypeClassLabel } from "~/instancetypes/options";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Instance type"} · kmc` }];
}

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, name } = params;
  if (!cluster || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const it = await getClusterInstanceType(cluster, name);
  return { it };
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
    await deleteClusterInstanceType(cluster, name);
    return redirect("/instancetypes");
  } catch (err) {
    return actionFailure("instancetype.delete", err, {
      intent,
      cluster,
      name,
    });
  }
}

export default function InstanceTypeDetailLayout({
  loaderData,
}: Route.ComponentProps) {
  const { it } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const base = instanceTypePath(it);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/instancetypes" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Instance Types
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {it.name}
            </Title>
            {it.builtin ? (
              <Badge variant="light" color="blue">
                Built-in
              </Badge>
            ) : (
              <Badge variant="light" color="gray">
                Custom
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            separator=" · "
            items={[
              {
                label: it.cluster,
                to: instanceTypesListPath({ cluster: it.cluster }),
              },
              { label: "VirtualMachineClusterInstancetype" },
              ...(it.class
                ? [{ label: instanceTypeClassLabel(it.class) }]
                : []),
            ]}
          />
        </div>
        <Group>
          {!it.builtin && (
            <>
              <Button
                component={Link}
                to={instanceTypeEditPath(it)}
                variant="default"
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
            </>
          )}
        </Group>
      </Group>

      {it.builtin && (
        <Alert color="blue" variant="light" title="Built-in instance type">
          Provided by the KubeVirt operator / common-instancetypes
          {it.vendor ? ` (${it.vendor})` : ""}. These types are managed outside
          kmc and cannot be edited or deleted here.
        </Alert>
      )}

      <DetailTabs
        items={[
          { label: "Overview", to: detailTabPath(base, "overview"), end: true },
          { label: "YAML", to: detailTabPath(base, "yaml") },
        ]}
      />

      <Outlet />

      {!it.builtin && (
        <ConfirmDeleteModal
          opened={deleteOpen}
          resourceName={it.name}
          identity={`${it.cluster}/${it.name}`}
          title="Delete instance type"
          confirmLabel="Delete Instance Type"
          loading={busy}
          onClose={() => setDeleteOpen(false)}
          onConfirm={() => {
            setDeleteOpen(false);
            fetcher.submit({ intent: "delete" }, { method: "post" });
          }}
        />
      )}
    </Stack>
  );
}
