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
  formatAge,
  formatDateTime,
  portForwardsListPath,
  routerPath,
  vmPath,
  vpcPath,
} from "~/lib/format";
import type { loader as detailLoader } from "./port-forwards.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/port-forwards.$cluster.$namespace.$name";

export default function PortForwardOverviewTab() {
  const { pf } = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField
              label="Protocol"
              value={
                <Badge size="sm" variant="light" color="blue">
                  {pf.protocol.toUpperCase()}
                </Badge>
              }
            />
            <DetailField
              label="Phase"
              value={pf.phase ? <StatusBadge status={pf.phase} /> : "—"}
            />
            <DetailField
              label="Programmed"
              value={
                pf.programmed == null ? "—" : pf.programmed ? "Yes" : "No"
              }
            />
            <DetailField label="Age" value={formatAge(pf.age)} />
            <DetailField label="Created" value={formatDateTime(pf.age)} />
            <DetailField
              label="Cluster"
              value={
                <ResourceLink
                  to={portForwardsListPath({ cluster: pf.cluster })}
                  dimmed
                >
                  {pf.cluster}
                </ResourceLink>
              }
            />
            <DetailField
              label="Namespace"
              value={
                <ResourceLink
                  to={portForwardsListPath({
                    cluster: pf.cluster,
                    namespace: pf.namespace,
                  })}
                  dimmed
                >
                  {pf.namespace}
                </ResourceLink>
              }
            />
            <DetailField label="Name" value={<Code>{pf.name}</Code>} />
            <DetailField
              label="UID"
              value={pf.uid ? <Code>{pf.uid}</Code> : "—"}
            />
          </SimpleGrid>
        </DetailSection>

        <DetailSection title="Mapping">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField
              label="Public"
              value={
                pf.public ? (
                  <Code>
                    {pf.public}:{pf.publicPort}
                  </Code>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Private"
              value={
                pf.private ? (
                  <Code>
                    {pf.private}:{pf.privatePort}
                  </Code>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Target VM"
              value={
                pf.targetVm ? (
                  <ResourceLink
                    to={vmPath({
                      cluster: pf.cluster,
                      namespace: pf.namespace,
                      name: pf.targetVm,
                    })}
                  >
                    {pf.targetVm}
                  </ResourceLink>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="VPC"
              value={
                pf.vpcName ? (
                  <ResourceLink
                    to={vpcPath({
                      cluster: pf.cluster,
                      namespace: pf.namespace,
                      name: pf.vpcName,
                    })}
                  >
                    {pf.vpcName}
                  </ResourceLink>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Router"
              value={
                pf.routerName ? (
                  <ResourceLink
                    to={routerPath({
                      cluster: pf.cluster,
                      namespace: pf.namespace,
                      name: pf.routerName,
                    })}
                  >
                    {pf.routerName}
                  </ResourceLink>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Agent"
              value={
                pf.agentStatus ? <StatusBadge status={pf.agentStatus} /> : "—"
              }
            />
            <DetailField
              label="Agent heartbeat"
              value={
                pf.agentHeartbeatAt
                  ? formatDateTime(pf.agentHeartbeatAt)
                  : "—"
              }
            />
            <DetailField
              label="Policy ConfigMap"
              value={
                pf.policyConfigMap ? <Code>{pf.policyConfigMap}</Code> : "—"
              }
            />
            {pf.observedGeneration != null ? (
              <DetailField
                label="Observed generation"
                value={String(pf.observedGeneration)}
              />
            ) : null}
          </SimpleGrid>
          <Text size="sm" c="dimmed" mt="sm">
            Port forwards share a public address (router primary or a held floating
            IP) without claiming a full 1:1 floating IP for the target VM. The router
            agent programs DNAT when Ready.
          </Text>
        </DetailSection>
      </SimpleGrid>

      <ConditionsSection conditions={pf.conditions} />
    </Stack>
  );
}
