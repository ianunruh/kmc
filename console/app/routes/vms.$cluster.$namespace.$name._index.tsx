import {
  Badge,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import {
  ClampedText,
  DetailField,
  DetailSection,
  ResourceLink,
} from "~/ui";
import { StatusBadge } from "~/ui/status-badge";
import {
  formatAge,
  formatDateTime,
  instanceTypePath,
  sizeLabel,
  vmsListPath,
} from "~/lib/format";
import { VmMetricsPanel } from "~/vms/vm-metrics-panel";
import { useVmDetail, volumeHref } from "~/vms/vm-detail-shared";

export default function VmOverviewTab() {
  const { vm, prometheusConfigured } = useVmDetail();

  const rootVolume =
    vm.volumes.find((v) => v.kind === "DataVolume" && v.linkName) ?? null;
  const rootVolumeHref = rootVolume
    ? volumeHref(vm.cluster, vm.namespace, rootVolume)
    : null;

  return (
    <Stack gap="md">
      {prometheusConfigured && (
        <VmMetricsPanel cluster={vm.cluster} namespace={vm.namespace} name={vm.name} />
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField
              label="Status"
              value={
                <ResourceLink
                  to={vmsListPath({ cluster: vm.cluster, status: vm.status })}
                  underline="never"
                >
                  <StatusBadge status={vm.status} />
                </ResourceLink>
              }
            />
            <DetailField label="Age" value={formatAge(vm.age)} />
            <DetailField label="Created" value={formatDateTime(vm.age)} />
            <DetailField
              label="Cluster"
              value={
                <ResourceLink to={vmsListPath({ cluster: vm.cluster })} dimmed>
                  {vm.cluster}
                </ResourceLink>
              }
            />
            <DetailField
              label="Namespace"
              value={
                <ResourceLink
                  to={vmsListPath({
                    cluster: vm.cluster,
                    namespace: vm.namespace,
                  })}
                  dimmed
                >
                  {vm.namespace}
                </ResourceLink>
              }
            />
            <DetailField label="Node" value={vm.nodeName} />
            <DetailField label="Size" value={sizeLabel(vm)} />
            <DetailField
              label="Disk"
              value={
                vm.disk && rootVolumeHref ? (
                  <ResourceLink to={rootVolumeHref}>{vm.disk}</ResourceLink>
                ) : (
                  vm.disk
                )
              }
            />
            <DetailField
              label="Instance type"
              value={
                vm.instanceType ? (
                  <ResourceLink
                    to={instanceTypePath({
                      cluster: vm.cluster,
                      name: vm.instanceType,
                    })}
                  >
                    {vm.instanceType}
                  </ResourceLink>
                ) : undefined
              }
            />
            <DetailField label="Preference" value={vm.preference} />
            <DetailField label="Run strategy" value={vm.runStrategy} />
            <DetailField label="Machine" value={vm.machineType} />
            <DetailField label="Architecture" value={vm.architecture} />
            <DetailField
              label="VMI phase"
              value={vm.vmiPhase ?? (vm.hasVmi ? "—" : "none")}
            />
            <DetailField label="IPv4 (live)" value={vm.ipv4Address} />
            <DetailField
              label="IPv4 (allocated)"
              value={
                vm.allocatedIpv4 ? (
                  <Stack gap={2}>
                    {vm.allocatedIpv4.split(",").map((part) => {
                      const s = part.trim();
                      return s ? <Code key={s}>{s}</Code> : null;
                    })}
                  </Stack>
                ) : undefined
              }
            />
            <DetailField
              label="UID"
              value={vm.uid ? <Code>{vm.uid}</Code> : undefined}
            />
          </SimpleGrid>
        </DetailSection>

        <DetailSection title="Guest agent">
          {!vm.hasVmi ? (
            <Text size="sm" c="dimmed">
              No live VMI — guest agent is only available while the VM is running.
            </Text>
          ) : (
            <Stack gap="sm">
              <SimpleGrid cols={2} spacing="sm">
                <DetailField
                  label="Agent"
                  value={
                    <Group gap={6} wrap="nowrap">
                      <Badge
                        size="sm"
                        variant="light"
                        color={vm.guestAgent?.connected ? "teal" : "gray"}
                      >
                        {vm.guestAgent?.connected ? "connected" : "not connected"}
                      </Badge>
                      {vm.guestAgent?.guestAgentVersion ? (
                        <Text size="xs" c="dimmed">
                          v{vm.guestAgent.guestAgentVersion}
                        </Text>
                      ) : null}
                    </Group>
                  }
                />
                <DetailField label="Hostname" value={vm.guestAgent?.hostname} />
                <DetailField
                  label="OS"
                  value={
                    vm.guestAgent?.osPrettyName || vm.guestAgent?.osName || undefined
                  }
                />
                <DetailField label="Version" value={vm.guestAgent?.osVersion} />
                <DetailField
                  label="Kernel"
                  value={
                    vm.guestAgent?.osKernelRelease ? (
                      <Code>{vm.guestAgent.osKernelRelease}</Code>
                    ) : undefined
                  }
                />
                <DetailField
                  label="Arch"
                  value={
                    vm.guestAgent?.osMachine ? (
                      <Code>{vm.guestAgent.osMachine}</Code>
                    ) : undefined
                  }
                />
                <DetailField label="Timezone" value={vm.guestAgent?.timezone} />
                <DetailField
                  label="OS id"
                  value={
                    vm.guestAgent?.osId ? <Code>{vm.guestAgent.osId}</Code> : undefined
                  }
                />
              </SimpleGrid>
              {vm.guestAgent?.osKernelVersion ? (
                <div>
                  <Text size="xs" c="dimmed" mb={2}>
                    Kernel version
                  </Text>
                  <ClampedText size="sm" c="dimmed" lineClamp={2}>
                    {vm.guestAgent.osKernelVersion}
                  </ClampedText>
                </div>
              ) : null}
            </Stack>
          )}
          {vm.hasVmi && !vm.guestAgent?.connected && (
            <Text size="xs" c="dimmed" mt="sm">
              Install and enable qemu-guest-agent in the guest for soft reboot, hostname,
              and richer OS info.
            </Text>
          )}
        </DetailSection>
      </SimpleGrid>

      <DetailSection title="Conditions">
        {vm.conditions.length === 0 ? (
          <Text size="sm" c="dimmed">
            No conditions
          </Text>
        ) : (
          <Table.ScrollContainer
            className="kmc-table-scroll"
            minWidth={720}
            type="native"
          >
            <Table className="kmc-table" verticalSpacing="xs" withRowBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Reason</Table.Th>
                  <Table.Th>Message</Table.Th>
                  <Table.Th>Last transition</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {vm.conditions.map((c) => (
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
                      <ClampedText size="sm" c="dimmed" maw={420} lineClamp={3}>
                        {c.message ?? "—"}
                      </ClampedText>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {formatDateTime(c.lastTransitionTime)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </DetailSection>
    </Stack>
  );
}
