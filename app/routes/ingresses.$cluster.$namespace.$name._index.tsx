import { Badge, Code, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import {
  DetailField,
  DetailSection,
  ResourceLink,
  ResourceTable,
  Table,
} from "~/ui";
import {
  formatAge,
  formatDateTime,
  ingressesListPath,
  vmPath,
} from "~/lib/format";
import type { IngressBackendInfo } from "~/lib/types";
import type { loader as detailLoader } from "./ingresses.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/ingresses.$cluster.$namespace.$name";

function membershipModeLabel(
  membership: IngressBackendInfo["membership"],
): string {
  switch (membership.mode) {
    case "single-vm":
      return "Single VM";
    case "unknown":
      return "Unknown";
    default: {
      const mode = (membership as { mode: string }).mode;
      return mode;
    }
  }
}

function formatSelector(selector: Record<string, string>): string {
  const entries = Object.entries(selector);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

export default function IngressOverviewTab() {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { ing } = data;
  const backend = ing.backend;
  const selectorText = backend ? formatSelector(backend.selector) : "";

  return (
    <Stack gap="md">
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

        <DetailSection title="Backend">
          {!backend || !backend.exists ? (
            <Text size="sm" c="dimmed">
              Companion Service not found (name: {ing.serviceName ?? ing.name})
            </Text>
          ) : (
            <SimpleGrid cols={2} spacing="sm">
              <DetailField
                label="Membership"
                value={
                  <Badge size="sm" variant="light" color="gray">
                    {membershipModeLabel(backend.membership)}
                  </Badge>
                }
              />
              <DetailField label="Service type" value={backend.serviceType} />
              <DetailField
                label="Target VM"
                value={
                  ing.vmName ? (
                    ing.vm?.exists === false ? (
                      <Text size="sm" c="dimmed">
                        {ing.vmName} (missing)
                      </Text>
                    ) : (
                      <Group gap="xs" wrap="wrap">
                        <ResourceLink
                          to={vmPath({
                            cluster: ing.cluster,
                            namespace: ing.namespace,
                            name: ing.vmName,
                          })}
                        >
                          {ing.vmName}
                        </ResourceLink>
                        {ing.vm && !ing.vm.podNetwork && (
                          <Badge size="sm" variant="light" color="orange">
                            Multus only
                          </Badge>
                        )}
                      </Group>
                    )
                  ) : (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  )
                }
              />
              <DetailField
                label="Selector"
                value={
                  selectorText ? (
                    <Code style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {selectorText}
                    </Code>
                  ) : (
                    <Text size="sm" c="dimmed">
                      (none)
                    </Text>
                  )
                }
              />
            </SimpleGrid>
          )}
        </DetailSection>
      </SimpleGrid>

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
    </Stack>
  );
}
