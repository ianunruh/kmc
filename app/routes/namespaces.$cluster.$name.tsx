import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Anchor,
} from "@mantine/core";
import { IconArrowLeft, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/namespaces.$cluster.$name";
import {
  ConfirmDeleteModal,
  DetailField,
  DetailSection,
  ResourceIdentity,
  ResourceLink,
  YamlPanel,
} from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  formatAge,
  formatDateTime,
  namespacesListPath,
  vpcsListPath,
  vmsListPath,
} from "~/lib/format";
import { VM_ALLOWED_LABEL } from "~/lib/k8s/constants";
import {
  deleteNamespace,
  getNamespace,
  getNamespaceYaml,
} from "~/namespaces/namespaces.server";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Namespace"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, name } = params;
  if (!cluster || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const [ns, yaml] = await Promise.all([
    getNamespace(cluster, name),
    getNamespaceYaml(cluster, name),
  ]);
  return { ns, yaml };
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

export default function NamespaceDetailPage({ loaderData }: Route.ComponentProps) {
  const { ns, yaml } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const hasVms = ns.vmCount > 0;

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

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField
              label="Cluster"
              value={
                <ResourceLink
                  to={namespacesListPath({ cluster: ns.cluster })}
                  dimmed
                >
                  {ns.cluster}
                </ResourceLink>
              }
            />
            <DetailField label="Name" value={ns.name} />
            <DetailField label="Phase" value={ns.phase} />
            <DetailField label="Age" value={formatAge(ns.age)} />
            <DetailField label="Created" value={formatDateTime(ns.age)} />
            <DetailField
              label="Virtual Machines"
              value={
                <ResourceLink
                  to={vmsListPath({
                    cluster: ns.cluster,
                    namespace: ns.name,
                  })}
                >
                  View VMs ({ns.vmCount})
                </ResourceLink>
              }
            />
            <DetailField
              label="VPCs"
              value={
                <ResourceLink
                  to={vpcsListPath({
                    cluster: ns.cluster,
                    namespace: ns.name,
                  })}
                >
                  View VPCs
                </ResourceLink>
              }
            />
            <DetailField
              label="UID"
              value={ns.uid ? <Code>{ns.uid}</Code> : undefined}
            />
          </SimpleGrid>
        </DetailSection>

        <DetailSection title="Labels">
          {Object.keys(ns.labels).length === 0 ? (
            <Text size="sm" c="dimmed">
              None
            </Text>
          ) : (
            <Stack gap={6}>
              {Object.entries(ns.labels).map(([k, v]) => (
                <Group key={k} gap="xs" wrap="nowrap" align="flex-start">
                  <Code
                    style={{
                      color:
                        k === VM_ALLOWED_LABEL ? "var(--mantine-color-teal-4)" : undefined,
                    }}
                  >
                    {k}
                  </Code>
                  <Text size="sm" c="dimmed">
                    {v}
                  </Text>
                </Group>
              ))}
            </Stack>
          )}
        </DetailSection>
      </SimpleGrid>

      {Object.keys(ns.annotations).length > 0 && (
        <DetailSection title="Annotations">
          <Stack gap={6}>
            {Object.entries(ns.annotations).map(([k, v]) => (
              <Group key={k} gap="xs" wrap="nowrap" align="flex-start">
                <Code>{k}</Code>
                <Text size="sm" c="dimmed" style={{ wordBreak: "break-all" }}>
                  {v}
                </Text>
              </Group>
            ))}
          </Stack>
        </DetailSection>
      )}

      <YamlPanel yaml={yaml} />

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
