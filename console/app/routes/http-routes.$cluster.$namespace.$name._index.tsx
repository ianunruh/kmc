import { Anchor, Badge, Code, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import {
  CopyButton,
  CopyableValue,
  DetailField,
  DetailSection,
  ResourceLink,
  ResourceTable,
  StatusBadge,
  Table,
} from "~/ui";
import {
  formatAge,
  formatDateTime,
  httpRouteHostUrl,
  httpRoutesListPath,
  loadBalancerPath,
  vmPath,
} from "~/lib/format";
import {
  formatLabelSelector,
  membershipModeLabel,
} from "~/backends/membership";
import type { loader as detailLoader } from "./http-routes.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/http-routes.$cluster.$namespace.$name";

export default function HttpRouteOverviewTab() {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { route } = data;
  const backend = route.backend;
  const selectorText = backend
    ? formatLabelSelector(backend.selector)
    : "";
  const matchedVms = backend?.matchedVms ?? [];
  const membership = backend?.membership;
  const parent = route.parentRefs[0];
  const parentLabel = parent
    ? `${parent.namespace && parent.namespace !== route.namespace ? `${parent.namespace}/` : ""}${parent.name}`
    : undefined;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField label="Age" value={formatAge(route.age)} />
            <DetailField label="Created" value={formatDateTime(route.age)} />
            <DetailField
              label="Cluster"
              value={
                <ResourceLink to={httpRoutesListPath({ cluster: route.cluster })} dimmed>
                  {route.cluster}
                </ResourceLink>
              }
            />
            <DetailField
              label="Namespace"
              value={
                <ResourceLink
                  to={httpRoutesListPath({
                    cluster: route.cluster,
                    namespace: route.namespace,
                  })}
                  dimmed
                >
                  {route.namespace}
                </ResourceLink>
              }
            />
            <DetailField label="Gateway" value={parentLabel} />
            <DetailField
              label="Listener"
              value={parent?.sectionName}
            />
            <DetailField
              label="Accepted"
              value={
                route.accepted == null
                  ? undefined
                  : route.accepted
                    ? "True"
                    : "False"
              }
            />
            <DetailField
              label="Address"
              value={
                route.address ? <CopyableValue value={route.address} /> : undefined
              }
            />
            <DetailField
              label="Hosts"
              value={
                route.hosts.length > 0 ? (
                  <Stack gap={4}>
                    {route.hosts.map((host) => {
                      const url = httpRouteHostUrl(host, route.httpsHosts);
                      return (
                        <Group key={host} gap={4} wrap="nowrap">
                          <Anchor
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            size="sm"
                          >
                            {host}
                          </Anchor>
                          <CopyButton value={url} label="Copy URL" size="xs" />
                        </Group>
                      );
                    })}
                  </Stack>
                ) : undefined
              }
            />
            <DetailField
              label="Service"
              value={
                route.serviceName ? (
                  backend?.serviceType === "LoadBalancer" ? (
                    <ResourceLink
                      to={loadBalancerPath({
                        cluster: route.cluster,
                        namespace: route.namespace,
                        name: route.serviceName,
                      })}
                    >
                      {route.serviceName}
                    </ResourceLink>
                  ) : (
                    <Code>{route.serviceName}</Code>
                  )
                ) : undefined
              }
            />
            <DetailField
              label="Endpoints"
              value={
                route.endpointsTotal != null
                  ? `${route.endpointsReady ?? 0}/${route.endpointsTotal} ready`
                  : undefined
              }
            />
          </SimpleGrid>
        </DetailSection>

        <DetailSection title="Backend">
          {!backend || !backend.exists ? (
            <Text size="sm" c="dimmed">
              Backend Service not found (name: {route.serviceName ?? route.name}).
              If this HTTPRoute was created with expose-existing, restore the Service
              or recreate the HTTPRoute.
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

              {membership?.mode === "single-vm" && (
                <DetailField
                  label="Target VM"
                  value={
                    route.vmName ? (
                      route.vm?.exists === false ? (
                        <Text size="sm" c="dimmed">
                          {route.vmName} (missing)
                        </Text>
                      ) : (
                        <Group gap="xs" wrap="wrap">
                          <ResourceLink
                            to={vmPath({
                              cluster: route.cluster,
                              namespace: route.namespace,
                              name: route.vmName,
                            })}
                          >
                            {route.vmName}
                          </ResourceLink>
                          {route.vm && !route.vm.podNetwork && (
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
              )}

              {membership?.mode === "group" && (
                <DetailField label="Group id" value={membership.groupId} />
              )}

              {membership?.mode === "labels" && (
                <DetailField
                  label="Match labels"
                  value={
                    <Code style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {formatLabelSelector(membership.matchLabels) || "—"}
                    </Code>
                  }
                />
              )}

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

      {backend?.exists && (
        <DetailSection
          title={`Matched VMs${matchedVms.length ? ` (${matchedVms.length})` : ""}`}
        >
          {matchedVms.length === 0 ? (
            <Text size="sm" c="dimmed">
              No VMs in this namespace match the Service selector. For group
              membership, running guests may need a restart before virt-launcher
              pods pick up the new labels.
            </Text>
          ) : (
            <ResourceTable
              headers={["Name", "Status", "Network"]}
              isEmpty={false}
            >
              {matchedVms.map((vm) => (
                <Table.Tr key={vm.name}>
                  <Table.Td>
                    <ResourceLink
                      to={vmPath({
                        cluster: route.cluster,
                        namespace: route.namespace,
                        name: vm.name,
                      })}
                    >
                      {vm.name}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge status={vm.status} />
                  </Table.Td>
                  <Table.Td>
                    {vm.podNetwork ? (
                      <Text size="sm" c="dimmed">
                        Pod
                      </Text>
                    ) : (
                      <Badge size="sm" variant="light" color="orange">
                        Multus only
                      </Badge>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </ResourceTable>
          )}
        </DetailSection>
      )}

      <DetailSection title="Service ports">
        {route.servicePorts && route.servicePorts.length > 0 ? (
          <ResourceTable
            headers={["Name", "Port", "Target", "Protocol"]}
            isEmpty={false}
          >
            {route.servicePorts.map((p, i) => (
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
            Companion Service not found (name: {route.serviceName ?? route.name})
          </Text>
        )}
      </DetailSection>

      <DetailSection title="Rules">
        {route.rules.length === 0 ? (
          <Text size="sm" c="dimmed">
            No rules configured
          </Text>
        ) : (
          <ResourceTable
            headers={["Host", "Path", "Path type", "Service", "Port"]}
            isEmpty={false}
          >
            {route.rules.flatMap((rule, ri) =>
              rule.matches.map((match, mi) => (
                <Table.Tr key={`${ri}-${mi}-${match.path}`}>
                  <Table.Td>
                    <Text size="sm">{route.hosts[0] || "*"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Code>{match.path}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {match.pathType}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{match.serviceName || "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{String(match.servicePort)}</Text>
                  </Table.Td>
                </Table.Tr>
              )),
            )}
          </ResourceTable>
        )}
      </DetailSection>
    </Stack>
  );
}
