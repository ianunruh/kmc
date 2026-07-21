import {
  Button,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Anchor,
} from "@mantine/core";
import { IconArrowLeft, IconPencil, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/instancetypes.$cluster.$name";
import {
  ConfirmDeleteModal,
  DetailField,
  DetailSection,
  EventsPanel,
  YamlPanel,
} from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import { formatAge, formatDateTime, instanceTypeEditPath } from "~/lib/format";
import { listResourceEvents } from "~/lib/k8s/events.server";
import { getCustomObjectYaml } from "~/lib/k8s/yaml.server";
import {
  deleteClusterInstanceType,
  getClusterInstanceType,
} from "~/instancetypes/instancetypes.server";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Instance type"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, name } = params;
  if (!cluster || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const [it, events, yaml] = await Promise.all([
    getClusterInstanceType(cluster, name),
    listResourceEvents({
      cluster,
      name,
      kinds: ["VirtualMachineClusterInstancetype"],
    }),
    getCustomObjectYaml({
      cluster,
      group: "instancetype.kubevirt.io",
      version: "v1beta1",
      plural: "virtualmachineclusterinstancetypes",
      name,
    }),
  ]);
  return { it, events, yaml };
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

export default function InstanceTypeDetailPage({ loaderData }: Route.ComponentProps) {
  const { it, events, yaml } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";

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
          <Group gap="sm" mt={6}>
            <Title order={2} size="h3">
              {it.name}
            </Title>
          </Group>
          <Text size="sm" c="dimmed" mt={4}>
            {it.cluster} · VirtualMachineClusterInstancetype
          </Text>
        </div>
        <Group>
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
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField label="Cluster" value={it.cluster} />
            <DetailField label="Name" value={it.name} />
            <DetailField label="CPU" value={`${it.cpu} cores`} />
            <DetailField label="Memory" value={it.memory} />
            <DetailField label="Age" value={formatAge(it.age)} />
            <DetailField label="Created" value={formatDateTime(it.age)} />
            <DetailField label="UID" value={it.uid ? <Code>{it.uid}</Code> : undefined} />
          </SimpleGrid>
        </DetailSection>

        <DetailSection title="Labels">
          {Object.keys(it.labels).length === 0 ? (
            <Text size="sm" c="dimmed">
              None
            </Text>
          ) : (
            <Stack gap={6}>
              {Object.entries(it.labels).map(([k, v]) => (
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

      <EventsPanel events={events} />
      <YamlPanel yaml={yaml} />

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
    </Stack>
  );
}
