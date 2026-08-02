import { Badge, Code, SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import {
  ConditionsSection,
  DetailField,
  DetailSection,
  ResourceLink,
  StatusBadge,
} from "~/ui";
import {
  floatingIpsListPath,
  formatAge,
  formatDateTime,
  routerPath,
  vmPath,
  vpcPath,
} from "~/lib/format";
import type { loader as detailLoader } from "./floating-ips.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/floating-ips.$cluster.$namespace.$name";

export default function FloatingIpOverviewTab() {
  const { fip } = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField
              label="State"
              value={
                <Badge
                  size="sm"
                  variant="light"
                  color={fip.state === "associated" ? "teal" : "yellow"}
                >
                  {fip.state}
                </Badge>
              }
            />
            <DetailField
              label="Phase"
              value={fip.phase ? <StatusBadge status={fip.phase} /> : "—"}
            />
            <DetailField
              label="Programmed"
              value={
                fip.programmed == null ? "—" : fip.programmed ? "Yes" : "No"
              }
            />
            <DetailField label="Age" value={formatAge(fip.age)} />
            <DetailField label="Created" value={formatDateTime(fip.age)} />
            <DetailField
              label="Cluster"
              value={
                <ResourceLink
                  to={floatingIpsListPath({ cluster: fip.cluster })}
                  dimmed
                >
                  {fip.cluster}
                </ResourceLink>
              }
            />
            <DetailField
              label="Namespace"
              value={
                <ResourceLink
                  to={floatingIpsListPath({
                    cluster: fip.cluster,
                    namespace: fip.namespace,
                  })}
                  dimmed
                >
                  {fip.namespace}
                </ResourceLink>
              }
            />
            <DetailField label="Name" value={<Code>{fip.name}</Code>} />
            <DetailField
              label="UID"
              value={fip.uid ? <Code>{fip.uid}</Code> : "—"}
            />
          </SimpleGrid>
        </DetailSection>

        <DetailSection title="Addresses">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField
              label="Public"
              value={
                fip.public ? (
                  <Code>
                    {fip.public}/{fip.prefix}
                  </Code>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Private"
              value={fip.private ? <Code>{fip.private}</Code> : "—"}
            />
            <DetailField
              label="Target VM"
              value={
                fip.targetVm ? (
                  <ResourceLink
                    to={vmPath({
                      cluster: fip.cluster,
                      namespace: fip.namespace,
                      name: fip.targetVm,
                    })}
                  >
                    {fip.targetVm}
                  </ResourceLink>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="VPC"
              value={
                fip.vpcName ? (
                  <ResourceLink
                    to={vpcPath({
                      cluster: fip.cluster,
                      namespace: fip.namespace,
                      name: fip.vpcName,
                    })}
                  >
                    {fip.vpcName}
                  </ResourceLink>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Router"
              value={
                fip.routerName ? (
                  <ResourceLink
                    to={routerPath({
                      cluster: fip.cluster,
                      namespace: fip.namespace,
                      name: fip.routerName,
                    })}
                  >
                    {fip.routerName}
                  </ResourceLink>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Agent"
              value={
                fip.agentStatus ? (
                  <StatusBadge status={fip.agentStatus} />
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Agent heartbeat"
              value={
                fip.agentHeartbeatAt
                  ? formatDateTime(fip.agentHeartbeatAt)
                  : "—"
              }
            />
            <DetailField
              label="Pool"
              value={
                fip.poolRef ? (
                  <Code>
                    {fip.poolRef.kind}/{fip.poolRef.name}
                  </Code>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Policy ConfigMap"
              value={
                fip.policyConfigMap ? <Code>{fip.policyConfigMap}</Code> : "—"
              }
            />
            {fip.observedGeneration != null ? (
              <DetailField
                label="Observed generation"
                value={String(fip.observedGeneration)}
              />
            ) : null}
          </SimpleGrid>
          {fip.state === "held" ? (
            <Text size="sm" c="dimmed" mt="sm">
              Held means the public address is reserved for this VPC but not mapped
              to a private target. Associate to apply DNAT/SNAT via the router agent.
            </Text>
          ) : null}
        </DetailSection>
      </SimpleGrid>

      <ConditionsSection conditions={fip.conditions} />
    </Stack>
  );
}
