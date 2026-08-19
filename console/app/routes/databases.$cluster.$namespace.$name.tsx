import {
  Anchor,
  Badge,
  Button,
  Group,
  Stack,
  Title,
} from "@mantine/core";
import { IconArrowLeft, IconTerminal2, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link, Outlet, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/databases.$cluster.$namespace.$name";
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
  canOpenDatabaseTerminal,
  databasePath,
  databasesListPath,
  databaseTerminalPath,
  detailTabPath,
} from "~/lib/format";
import { deleteDatabase, getDatabase } from "~/databases/databases.server";
import { hasClusterPrometheus } from "~/lib/k8s/cluster-config.server";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Database"} · kmc` }];
}

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const db = await getDatabase(cluster, namespace, name);
  return {
    db,
    prometheusConfigured: hasClusterPrometheus(cluster),
  };
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
    await deleteDatabase(cluster, namespace, name);
    return redirect("/databases");
  } catch (err) {
    return actionFailure("database.delete", err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

export default function DatabaseDetailLayout({ loaderData }: Route.ComponentProps) {
  const { db } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const base = databasePath(db);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    } else if (data.ok) {
      notifyActionSuccess("Done", "Database cluster deleted");
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/databases" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Databases
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {db.name}
            </Title>
            <ResourceLink
              to={databasesListPath({ cluster: db.cluster, status: db.status })}
              underline="never"
            >
              <StatusBadge status={db.status} />
            </ResourceLink>
            {db.managedByKmc ? (
              <Badge size="sm" variant="light" color="accent">
                kmc
              </Badge>
            ) : (
              <Badge size="sm" variant="outline" color="gray">
                external
              </Badge>
            )}
            {db.sizePreset ? (
              <Badge size="sm" variant="light" color="gray">
                {db.sizePreset}
              </Badge>
            ) : null}
          </Group>
          <ResourceIdentity
            items={[
              { label: db.cluster, to: databasesListPath({ cluster: db.cluster }) },
              {
                label: db.namespace,
                to: databasesListPath({
                  cluster: db.cluster,
                  namespace: db.namespace,
                }),
              },
            ]}
          />
        </div>
        <Group gap="xs" wrap="wrap" justify="flex-end">
          <Button
            component={Link}
            to={databaseTerminalPath(db)}
            variant="default"
            leftSection={<IconTerminal2 size={16} />}
            disabled={!canOpenDatabaseTerminal(db)}
            title={
              canOpenDatabaseTerminal(db)
                ? "Open psql as the app user"
                : "psql requires a primary instance"
            }
          >
            Terminal
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
        resourceName={db.name}
        identity={`${db.cluster}/${db.namespace}/${db.name}`}
        title="Delete database"
        confirmLabel="Delete cluster"
        warning={
          db.managedByKmc
            ? "Deletes the CloudNativePG Cluster and typically its PVCs. Data will be lost."
            : "This cluster was not created by kmc. Deleting removes the CloudNativePG Cluster and typically its PVCs — data will be lost."
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
