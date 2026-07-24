import {
  ActionIcon,
  Badge,
  Group,
  Menu,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconDotsVertical,
  IconEdit,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, useFetcher } from "react-router";
import type { VmLifecycleIntent, VmSummary } from "~/lib/types";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import {
  canOpenConsole,
  canPause,
  canRestart,
  canSoftReboot,
  canStart,
  canStop,
  canUnpause,
  dataVolumePath,
  formatAge,
  instanceTypePath,
  sizeLabel,
  vmConsolePath,
  vmEditPath,
  vmPath,
  vmTerminalPath,
  vmsListPath,
} from "~/lib/format";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { ClampedText, ConfirmDeleteModal, ResourceLink } from "~/ui";
import { StatusBadge } from "~/ui/status-badge";

/**
 * Strip optional /prefix from kmc.ianunruh.com/ipv4 for the list column.
 * Multi-attach stores comma-separated addresses — show the first (primary).
 */
function displayAllocatedIpv4(value?: string): string | undefined {
  if (!value) return undefined;
  const first = value.split(",")[0]?.trim();
  if (!first) return undefined;
  return first.includes("/") ? first.slice(0, first.indexOf("/")) : first;
}

export function VmTable({ vms }: { vms: VmSummary[] }) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const { refreshNow } = useRefresh();
  const [deleteTarget, setDeleteTarget] = useState<VmSummary | null>(null);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
    } else if (data.ok) {
      const label =
        data.intent === "softreboot"
          ? "soft reboot"
          : data.intent === "restart"
            ? "hard restart"
            : (data.intent ?? "action");
      notifyActionSuccess("Done", `VM ${label} requested`);
      refreshNow();
    }
  });

  const busy = fetcher.state !== "idle";

  function submitIntent(intent: VmLifecycleIntent, vm: VmSummary) {
    fetcher.submit(
      {
        intent,
        cluster: vm.cluster,
        namespace: vm.namespace,
        name: vm.name,
      },
      { method: "post" },
    );
  }

  if (vms.length === 0) {
    return (
      <Text c="dimmed" size="sm" py="xl" ta="center">
        No virtual machines found across configured clusters.
      </Text>
    );
  }

  return (
    <>
      <Table.ScrollContainer className="kmc-table-scroll" minWidth={800} type="native">
        <Table
          className="kmc-table"
          highlightOnHover
          verticalSpacing="sm"
          horizontalSpacing="md"
          withRowBorders
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Cluster</Table.Th>
              <Table.Th>Namespace</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>IPv4</Table.Th>
              <Table.Th>Instance type</Table.Th>
              <Table.Th>Disk</Table.Th>
              <Table.Th>Age</Table.Th>
              <Table.Th w={48} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {vms.map((vm) => {
              const key = `${vm.cluster}/${vm.namespace}/${vm.name}`;
              const ipv4 = displayAllocatedIpv4(vm.allocatedIpv4);
              return (
                <Table.Tr key={key}>
                  <Table.Td>
                    <ResourceLink to={vmPath(vm)}>{vm.name}</ResourceLink>
                    {vm.message && (
                      <ClampedText size="xs" c="dimmed" lineClamp={1} maw={280}>
                        {vm.message}
                      </ClampedText>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink to={vmsListPath({ cluster: vm.cluster })} dimmed>
                      {vm.cluster}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={vmsListPath({ cluster: vm.cluster, namespace: vm.namespace })}
                      dimmed
                    >
                      {vm.namespace}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <ResourceLink
                        to={vmsListPath({ cluster: vm.cluster, status: vm.status })}
                        underline="never"
                      >
                        <StatusBadge status={vm.status} />
                      </ResourceLink>
                      {vm.restartRequired && (
                        <Tooltip
                          label={
                            vm.restartRequiredMessage?.trim() ||
                            "LiveUpdate change needs a guest reboot"
                          }
                        >
                          <Badge size="xs" variant="light" color="orange">
                            restart
                          </Badge>
                        </Tooltip>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Stack gap={2}>
                      <Text size="sm" ff="monospace" c={ipv4 ? undefined : "dimmed"}>
                        {ipv4 ?? "—"}
                      </Text>
                      {vm.floatingIpv4 && vm.floatingIpv4.length > 0 ? (
                        <Tooltip
                          label={`Floating IP${vm.floatingIpv4.length > 1 ? "s" : ""}`}
                        >
                          <Text size="xs" ff="monospace" c="teal.5">
                            {vm.floatingIpv4.join(", ")}
                          </Text>
                        </Tooltip>
                      ) : null}
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Stack gap={2}>
                      {vm.instanceType ? (
                        <ResourceLink
                          to={instanceTypePath({
                            cluster: vm.cluster,
                            name: vm.instanceType,
                          })}
                        >
                          {vm.instanceType}
                        </ResourceLink>
                      ) : (
                        <Text size="sm" c="dimmed">
                          Custom
                        </Text>
                      )}
                      <Text size="xs" c="dimmed">
                        {sizeLabel(vm)}
                      </Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    {vm.disk && vm.diskDataVolume ? (
                      <ResourceLink
                        to={dataVolumePath({
                          cluster: vm.cluster,
                          namespace: vm.namespace,
                          name: vm.diskDataVolume,
                        })}
                        dimmed
                      >
                        {vm.disk}
                      </ResourceLink>
                    ) : (
                      <Text size="sm" c="dimmed">
                        {vm.disk ?? "—"}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={vm.age || "unknown"}>
                      <Text size="sm" c="dimmed">
                        {formatAge(vm.age)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Menu shadow="md" width={190} position="bottom-end">
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`Actions for ${vm.name}`}
                        >
                          <IconDotsVertical size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          component={Link}
                          to={vmTerminalPath(vm)}
                          leftSection={<IconTerminal2 size={14} />}
                          disabled={!canOpenConsole(vm)}
                          title={
                            canOpenConsole(vm)
                              ? "Open SSH terminal"
                              : "Terminal requires a live VMI (Running)"
                          }
                        >
                          Terminal
                        </Menu.Item>
                        <Menu.Item
                          component={Link}
                          to={vmConsolePath(vm)}
                          leftSection={<IconTerminal2 size={14} />}
                          disabled={!canOpenConsole(vm)}
                          title={
                            canOpenConsole(vm)
                              ? "Open serial console"
                              : "Serial console requires a live VMI (Running)"
                          }
                        >
                          Serial
                        </Menu.Item>
                        <Menu.Item
                          component={Link}
                          to={vmEditPath(vm)}
                          leftSection={<IconEdit size={14} />}
                        >
                          Edit
                        </Menu.Item>
                        <Menu.Divider />
                        <Menu.Item
                          leftSection={<IconPlayerStop size={14} />}
                          disabled={!canStop(vm) || busy}
                          title={
                            vm.status === "Paused"
                              ? "Unpause the VM before stopping"
                              : undefined
                          }
                          onClick={() => submitIntent("stop", vm)}
                        >
                          Stop
                        </Menu.Item>
                        <Menu.Item
                          leftSection={<IconPlayerPlay size={14} />}
                          disabled={!canStart(vm) || busy}
                          onClick={() => submitIntent("start", vm)}
                        >
                          Start
                        </Menu.Item>
                        <Menu.Item
                          leftSection={<IconRefresh size={14} />}
                          disabled={!canSoftReboot(vm) || busy}
                          title="ACPI soft reboot (guest-initiated)"
                          onClick={() => submitIntent("softreboot", vm)}
                        >
                          Soft reboot
                        </Menu.Item>
                        <Menu.Item
                          leftSection={<IconRefresh size={14} />}
                          disabled={!canRestart(vm) || busy}
                          title="Tear down and recreate the domain"
                          onClick={() => submitIntent("restart", vm)}
                        >
                          Hard restart
                        </Menu.Item>
                        {canUnpause(vm) ? (
                          <Menu.Item
                            leftSection={<IconPlayerPlay size={14} />}
                            disabled={busy}
                            onClick={() => submitIntent("unpause", vm)}
                          >
                            Unpause
                          </Menu.Item>
                        ) : (
                          <Menu.Item
                            leftSection={<IconPlayerPause size={14} />}
                            disabled={!canPause(vm) || busy}
                            onClick={() => submitIntent("pause", vm)}
                          >
                            Pause
                          </Menu.Item>
                        )}
                        <Menu.Divider />
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          disabled={busy}
                          onClick={() => setDeleteTarget(vm)}
                        >
                          Delete
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <ConfirmDeleteModal
        opened={deleteTarget != null}
        resourceName={deleteTarget?.name ?? null}
        identity={
          deleteTarget
            ? `${deleteTarget.cluster}/${deleteTarget.namespace}/${deleteTarget.name}`
            : null
        }
        title="Delete virtual machine"
        confirmLabel="Delete VM"
        warning="Owned disks (DataVolumes) may also be removed."
        loading={busy}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            submitIntent("delete", deleteTarget);
            setDeleteTarget(null);
          }
        }}
      />
    </>
  );
}
