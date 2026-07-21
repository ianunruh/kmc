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
import type { Route } from "./+types/ingresses.$cluster.$namespace.$name";
import {
  ConfirmDeleteModal,
  DetailField,
  DetailSection,
  EventsPanel,
  ResourceIdentity,
  ResourceLink,
  ResourceTable,
  Table,
  YamlPanel,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  formatAge,
  formatDateTime,
  ingressesListPath,
  vmPath,
} from "~/lib/format";
import { listResourceEvents } from "~/lib/k8s/events.server";
import {
  deleteIngress,
  getIngress,
  getIngressYaml,
} from "~/ingresses/ingresses.server";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Ingress"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const [ing, events, yaml] = await Promise.all([
    getIngress(cluster, namespace, name),
    listResourceEvents({
      cluster,
      namespace,
      name,
      kinds: ["Ingress", "Service"],
    }),
    getIngressYaml(cluster, namespace, name),
  ]);
  return { ing, events, yaml };
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
    await deleteIngress(cluster, namespace, name);
    return redirect("/ingresses");
  } catch (err) {
    return actionFailure("ingress.delete", err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

export default function IngressDetailPage({ loaderData }: Route.ComponentProps) {
  const { ing, events, yaml } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = fetcher.state !== "idle";

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Delete failed", data.error);
    } else if (data.ok) {
      notifyActionSuccess("Done", "Ingress deleted");
    }
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/ingresses" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Ingresses
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {ing.name}
            </Title>
            {ing.className && (
              <Badge variant="light" color="gray">
                {ing.className}
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            items={[
              { label: ing.cluster, to: ingressesListPath({ cluster: ing.cluster }) },
              {
                label: ing.namespace,
                to: ingressesListPath({
                  cluster: ing.cluster,
                  namespace: ing.namespace,
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

      {ing.vm && !ing.vm.exists && (
        <Alert color="yellow" variant="light" title="Target VM missing">
          Bound VM <Code>{ing.vm.name}</Code> was not found in this namespace.
          The Service may have empty endpoints.
        </Alert>
      )}
      {ing.vm?.exists && !ing.vm.podNetwork && (
        <Alert color="yellow" variant="light" title="Multus network">
          Target VM uses Multus. The companion Service selects the virt-launcher
          pod IP, not Multus guest addresses.
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField label="Age" value={formatAge(ing.age)} />
            <DetailField label="Created" value={formatDateTime(ing.age)} />
            <DetailField
              label="Cluster"
              value={
                <ResourceLink to={ingressesListPath({ cluster: ing.cluster })} dimmed>
                  {ing.cluster}
                </ResourceLink>
              }
            />
            <DetailField
              label="Namespace"
              value={
                <ResourceLink
                  to={ingressesListPath({
                    cluster: ing.cluster,
                    namespace: ing.namespace,
                  })}
                  dimmed
                >
                  {ing.namespace}
                </ResourceLink>
              }
            />
            <DetailField label="Ingress class" value={ing.className} />
            <DetailField label="Address" value={ing.address} />
            <DetailField
              label="Hosts"
              value={ing.hosts.length > 0 ? ing.hosts.join(", ") : undefined}
            />
            <DetailField
              label="Target VM"
              value={
                ing.vmName ? (
                  ing.vm?.exists === false ? (
                    <Text size="sm" c="dimmed">
                      {ing.vmName} (missing)
                    </Text>
                  ) : (
                    <ResourceLink
                      to={vmPath({
                        cluster: ing.cluster,
                        namespace: ing.namespace,
                        name: ing.vmName,
                      })}
                    >
                      {ing.vmName}
                    </ResourceLink>
                  )
                ) : undefined
              }
            />
            <DetailField label="Service" value={ing.serviceName} />
            <DetailField
              label="Endpoints"
              value={
                ing.endpointsTotal != null
                  ? `${ing.endpointsReady ?? 0}/${ing.endpointsTotal} ready`
                  : undefined
              }
            />
          </SimpleGrid>
        </DetailSection>

        <DetailSection title="Service ports">
          {ing.servicePorts && ing.servicePorts.length > 0 ? (
            <ResourceTable
              headers={["Name", "Port", "Target", "Protocol"]}
              isEmpty={false}
            >
              {ing.servicePorts.map((p, i) => (
                <Table.Tr key={`${p.name ?? "port"}-${p.port}-${i}`}>
                  <Table.Td>
                    <Text size="sm">{p.name ?? "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{p.port}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{String(p.targetPort)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {p.protocol ?? "TCP"}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </ResourceTable>
          ) : (
            <Text size="sm" c="dimmed">
              Companion Service not found (name: {ing.serviceName ?? ing.name})
            </Text>
          )}
        </DetailSection>
      </SimpleGrid>

      <DetailSection title="Rules">
        {ing.rules.length === 0 ? (
          <Text size="sm" c="dimmed">
            No rules configured
          </Text>
        ) : (
          <ResourceTable
            headers={["Host", "Path", "Path type", "Service", "Port"]}
            isEmpty={false}
          >
            {ing.rules.flatMap((rule, ri) =>
              rule.paths.map((path, pi) => (
                <Table.Tr key={`${ri}-${pi}-${path.path}`}>
                  <Table.Td>
                    <Text size="sm">{rule.host || "*"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Code>{path.path}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {path.pathType}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{path.serviceName || "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{String(path.servicePort)}</Text>
                  </Table.Td>
                </Table.Tr>
              )),
            )}
          </ResourceTable>
        )}
      </DetailSection>

      {ing.tls && ing.tls.length > 0 && (
        <DetailSection title="TLS">
          <ResourceTable headers={["Hosts", "Secret"]} isEmpty={false}>
            {ing.tls.map((t, i) => (
              <Table.Tr key={`tls-${i}`}>
                <Table.Td>
                  <Text size="sm">
                    {t.hosts.length > 0 ? t.hosts.join(", ") : "—"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{t.secretName ?? "—"}</Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </ResourceTable>
        </DetailSection>
      )}

      {(Object.keys(ing.labels).length > 0 ||
        Object.keys(ing.annotations).length > 0) && (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          <DetailSection title="Labels">
            {Object.keys(ing.labels).length === 0 ? (
              <Text size="sm" c="dimmed">
                None
              </Text>
            ) : (
              <Stack gap={4}>
                {Object.entries(ing.labels)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => (
                    <Text key={k} size="sm" ff="monospace">
                      {k}={v}
                    </Text>
                  ))}
              </Stack>
            )}
          </DetailSection>
          <DetailSection title="Annotations">
            {Object.keys(ing.annotations).length === 0 ? (
              <Text size="sm" c="dimmed">
                None
              </Text>
            ) : (
              <Stack gap={4}>
                {Object.entries(ing.annotations)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => (
                    <Text key={k} size="sm" ff="monospace" style={{ wordBreak: "break-all" }}>
                      {k}={v}
                    </Text>
                  ))}
              </Stack>
            )}
          </DetailSection>
        </SimpleGrid>
      )}

      <EventsPanel events={events} />
      <YamlPanel yaml={yaml} />

      <ConfirmDeleteModal
        opened={deleteOpen}
        resourceName={ing.name}
        identity={`${ing.cluster}/${ing.namespace}/${ing.name}`}
        title="Delete Ingress"
        confirmLabel="Delete Ingress"
        warning="Also deletes the companion ClusterIP Service with the same name. The VirtualMachine is not affected."
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
