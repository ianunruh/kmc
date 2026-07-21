import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconArrowLeft, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/datavolumes.$cluster.$namespace.$name";
import { StatusBadge } from "~/ui/status-badge";
import {
  ConfirmDeleteModal,
  DetailField,
  DetailSection,
  ResourceTable,
  Table,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import { formatAge, formatDateTime } from "~/lib/format";
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
  return { dv: await getDataVolume(cluster, namespace, name) };
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

export default function DataVolumeDetailPage({ loaderData }: Route.ComponentProps) {
  const { dv } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";

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
            <StatusBadge status={dv.phase} />
          </Group>
          <Text size="sm" c="dimmed" mt={4}>
            {dv.cluster} / {dv.namespace}
          </Text>
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

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField label="Phase" value={<StatusBadge status={dv.phase} />} />
            <DetailField label="Progress" value={dv.progress} />
            <DetailField label="Age" value={formatAge(dv.age)} />
            <DetailField label="Created" value={formatDateTime(dv.age)} />
            <DetailField label="Cluster" value={dv.cluster} />
            <DetailField label="Namespace" value={dv.namespace} />
            <DetailField label="Size" value={dv.size} />
            <DetailField label="Storage class" value={dv.storageClass} />
            <DetailField label="Volume mode" value={dv.volumeMode} />
            <DetailField label="Access modes" value={dv.accessModes?.join(", ")} />
            <DetailField label="Claim" value={dv.claimName} />
            <DetailField
              label="Owner"
              value={dv.ownerName ? `${dv.ownerKind}/${dv.ownerName}` : undefined}
            />
            <DetailField label="Source" value={dv.sourceKind} />
            <DetailField label="Source detail" value={dv.sourceDetail} />
            <DetailField label="UID" value={dv.uid ? <Code>{dv.uid}</Code> : undefined} />
          </SimpleGrid>
        </DetailSection>

        <DetailSection title="Labels">
          {Object.keys(dv.labels).length === 0 ? (
            <Text size="sm" c="dimmed">
              None
            </Text>
          ) : (
            <Stack gap={6}>
              {Object.entries(dv.labels).map(([k, v]) => (
                <Group key={k} gap="xs">
                  <Code>{k}</Code>
                  <Text size="sm" c="dimmed">
                    {v}
                  </Text>
                </Group>
              ))}
            </Stack>
          )}
        </DetailSection>
      </SimpleGrid>

      <DetailSection title="Conditions">
        <ResourceTable
          isEmpty={dv.conditions.length === 0}
          emptyMessage="No conditions"
          headers={["Type", "Status", "Reason", "Message", "Last transition"]}
        >
          {dv.conditions.map((c) => (
            <Table.Tr key={c.type}>
              <Table.Td>{c.type}</Table.Td>
              <Table.Td>
                <Badge
                  size="sm"
                  variant="light"
                  color={
                    c.status === "True"
                      ? "teal"
                      : c.status === "False"
                        ? "gray"
                        : "yellow"
                  }
                >
                  {c.status}
                </Badge>
              </Table.Td>
              <Table.Td>{c.reason ?? "—"}</Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed" maw={420} lineClamp={3}>
                  {c.message ?? "—"}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {formatDateTime(c.lastTransitionTime)}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </ResourceTable>
      </DetailSection>

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
