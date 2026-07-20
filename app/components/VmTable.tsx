import {
  ActionIcon,
  Menu,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconDotsVertical,
  IconPlayerPlay,
  IconPlayerStop,
  IconTrash,
} from "@tabler/icons-react";
import { useFetcher } from "react-router";
import { useEffect, useState } from "react";
import type { VmSummary } from "~/lib/types";
import { StatusBadge } from "./StatusBadge";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal";
import { notifications } from "@mantine/notifications";

function formatAge(iso: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

function sizeLabel(vm: VmSummary): string {
  if (vm.cpu && vm.memory) return `${vm.cpu} / ${vm.memory}`;
  if (vm.cpu) return vm.cpu;
  if (vm.memory) return vm.memory;
  return "—";
}

function canStop(vm: VmSummary): boolean {
  return ["Running", "Starting", "Paused", "Migrating"].includes(vm.status);
}

function canStart(vm: VmSummary): boolean {
  return ["Stopped", "Error"].includes(vm.status);
}

export function VmTable({ vms }: { vms: VmSummary[] }) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const [deleteTarget, setDeleteTarget] = useState<VmSummary | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.error) {
      notifications.show({
        color: "red",
        title: "Action failed",
        message: fetcher.data.error,
      });
    } else if (fetcher.data.ok) {
      notifications.show({
        color: "teal",
        title: "Done",
        message: `VM ${fetcher.data.intent ?? "action"} requested`,
      });
    }
  }, [fetcher.state, fetcher.data]);

  const busy = fetcher.state !== "idle";

  function submitIntent(
    intent: "stop" | "start" | "delete",
    vm: VmSummary,
  ) {
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
            <Table.Th>Size</Table.Th>
            <Table.Th>Disk</Table.Th>
            <Table.Th>Age</Table.Th>
            <Table.Th w={48} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {vms.map((vm) => {
            const key = `${vm.cluster}/${vm.namespace}/${vm.name}`;
            return (
              <Table.Tr key={key}>
                <Table.Td>
                  <Text fw={600} size="sm">
                    {vm.name}
                  </Text>
                  {vm.message && (
                    <Text size="xs" c="dimmed" lineClamp={1} maw={280}>
                      {vm.message}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {vm.cluster}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {vm.namespace}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <StatusBadge status={vm.status} />
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{sizeLabel(vm)}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {vm.disk ?? "—"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Tooltip label={vm.age || "unknown"}>
                    <Text size="sm" c="dimmed">
                      {formatAge(vm.age)}
                    </Text>
                  </Tooltip>
                </Table.Td>
                <Table.Td>
                  <Menu shadow="md" width={160} position="bottom-end">
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
                        leftSection={<IconPlayerStop size={14} />}
                        disabled={!canStop(vm) || busy}
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

      <ConfirmDeleteModal
        vm={deleteTarget}
        opened={deleteTarget != null}
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
