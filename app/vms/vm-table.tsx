import { ActionIcon, Menu, Table, Text, Tooltip } from "@mantine/core";
import {
  IconDotsVertical,
  IconPlayerPlay,
  IconPlayerStop,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { useFetcher } from "react-router";
import type { VmSummary } from "~/lib/types";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import {
  canStart,
  canStop,
  formatAge,
  sizeLabel,
  vmPath,
  vmsListPath,
} from "~/lib/format";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { ClampedText, ConfirmDeleteModal, ResourceLink } from "~/ui";
import { StatusBadge } from "~/ui/status-badge";

export function VmTable({ vms }: { vms: VmSummary[] }) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const { refreshNow } = useRefresh();
  const [deleteTarget, setDeleteTarget] = useState<VmSummary | null>(null);

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
    } else if (data.ok) {
      notifyActionSuccess("Done", `VM ${data.intent ?? "action"} requested`);
      refreshNow();
    }
  });

  const busy = fetcher.state !== "idle";

  function submitIntent(intent: "stop" | "start" | "delete", vm: VmSummary) {
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
                  <ResourceLink
                    to={vmsListPath({ cluster: vm.cluster, status: vm.status })}
                    underline="never"
                  >
                    <StatusBadge status={vm.status} />
                  </ResourceLink>
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
