import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  Menu,
  Radio,
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
import { useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import type {
  BulkActionResult,
  BulkActionSummary,
  VmBulkLifecycleIntent,
  VmLifecycleIntent,
  VmSummary,
} from "~/lib/types";
import {
  notifyActionError,
  notifyActionSuccess,
  notifyBulkResult,
} from "~/lib/action-feedback";
import { bulkTargetsJson, isBulkActionResult } from "~/lib/bulk-action";
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
import { resourceKey, useRowSelection } from "~/lib/use-row-selection";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import {
  BulkActionBar,
  ClampedText,
  ConfirmBulkDeleteModal,
  ConfirmDeleteModal,
  ResourceLink,
} from "~/ui";
import { StatusBadge } from "~/ui/status-badge";

type VmActionResult =
  | {
      ok?: boolean;
      error?: string;
      intent?: string;
      retainDisks?: boolean;
      retainedDisks?: string[];
    }
  | BulkActionResult;

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

function mergeClientSkipped(
  summary: BulkActionSummary,
  clientSkipped: number,
): BulkActionSummary {
  if (clientSkipped <= 0) return summary;
  return {
    total: summary.total + clientSkipped,
    succeeded: summary.succeeded,
    skipped: summary.skipped + clientSkipped,
    failed: summary.failed,
  };
}

export function VmTable({ vms }: { vms: VmSummary[] }) {
  const fetcher = useFetcher<VmActionResult>();
  const { refreshNow } = useRefresh();
  const [deleteTarget, setDeleteTarget] = useState<VmSummary | null>(null);
  const [retainDisks, setRetainDisks] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkRetainDisks, setBulkRetainDisks] = useState(false);
  /** Eligibility skips computed client-side before bulk start/stop submit. */
  const clientSkippedRef = useRef(0);

  const visibleKeys = useMemo(() => vms.map(resourceKey), [vms]);
  const selection = useRowSelection(visibleKeys);
  const { selected, selectedCount, clear, isSelected, toggle, toggleAllVisible, allSelected, someSelected } =
    selection;

  const selectedVms = useMemo(() => {
    if (selectedCount === 0) return [] as VmSummary[];
    return vms.filter((vm) => selected.has(resourceKey(vm)));
  }, [vms, selected, selectedCount]);

  const startableSelected = useMemo(
    () => selectedVms.filter(canStart),
    [selectedVms],
  );
  const stoppableSelected = useMemo(
    () => selectedVms.filter(canStop),
    [selectedVms],
  );

  useFetcherResult(fetcher, (data) => {
    if (isBulkActionResult(data)) {
      if (data.error && data.results.length === 0) {
        notifyActionError("Bulk action failed", data.error, {
          intent: data.intent,
        });
        clientSkippedRef.current = 0;
        return;
      }
      const verb =
        data.intent === "bulk-start"
          ? "started"
          : data.intent === "bulk-stop"
            ? "stopped"
            : data.retainDisks
              ? "deleted (disks retained)"
              : "deleted";
      const summary = mergeClientSkipped(data.summary, clientSkippedRef.current);
      clientSkippedRef.current = 0;
      notifyBulkResult(verb, summary, data.results);
      clear();
      setBulkDeleteOpen(false);
      refreshNow();
      return;
    }

    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
    } else if (data.ok) {
      if (data.intent === "delete" && data.retainDisks) {
        const disks = data.retainedDisks ?? [];
        notifyActionSuccess(
          "Done",
          disks.length > 0
            ? `VM deleted; disks retained: ${disks.join(", ")}`
            : "VM deleted; no owned disks were retained",
        );
      } else {
        const label =
          data.intent === "softreboot"
            ? "soft reboot"
            : data.intent === "restart"
              ? "hard restart"
              : (data.intent ?? "action");
        notifyActionSuccess("Done", `VM ${label} requested`);
      }
      refreshNow();
    }
  });

  const busy = fetcher.state !== "idle";

  function openDelete(vm: VmSummary) {
    setRetainDisks(false);
    setDeleteTarget(vm);
  }

  function closeDelete() {
    setRetainDisks(false);
    setDeleteTarget(null);
  }

  function submitIntent(
    intent: VmLifecycleIntent,
    vm: VmSummary,
    options?: { retainDisks?: boolean },
  ) {
    const payload: Record<string, string> = {
      intent,
      cluster: vm.cluster,
      namespace: vm.namespace,
      name: vm.name,
    };
    if (intent === "delete") {
      payload.retainDisks = options?.retainDisks ? "true" : "false";
    }
    fetcher.submit(payload, { method: "post" });
  }

  function submitBulk(
    intent: VmBulkLifecycleIntent,
    targets: VmSummary[],
    options?: { retainDisks?: boolean; clientSkipped?: number },
  ) {
    const clientSkipped = options?.clientSkipped ?? 0;
    if (targets.length === 0) {
      if (clientSkipped > 0) {
        notifyBulkResult(intent === "bulk-start" ? "started" : "stopped", {
          total: clientSkipped,
          succeeded: 0,
          skipped: clientSkipped,
          failed: 0,
        });
        clear();
      }
      return;
    }
    clientSkippedRef.current = clientSkipped;
    const payload: Record<string, string> = {
      intent,
      targets: bulkTargetsJson(
        targets.map((vm) => ({
          cluster: vm.cluster,
          namespace: vm.namespace,
          name: vm.name,
        })),
      ),
    };
    if (intent === "bulk-delete") {
      payload.retainDisks = options?.retainDisks ? "true" : "false";
    }
    fetcher.submit(payload, { method: "post" });
  }

  if (vms.length === 0) {
    return (
      <Text c="dimmed" size="sm" py="xl" ta="center">
        No virtual machines found across configured clusters.
      </Text>
    );
  }

  const bulkIdentities = selectedVms.map(resourceKey);

  return (
    <>
      <Stack gap="sm">
        <BulkActionBar
          selectedCount={selectedCount}
          onClear={clear}
          disabled={busy}
        >
          <Tooltip
            label={
              startableSelected.length === 0
                ? "No selected VMs are eligible to start"
                : selectedCount > startableSelected.length
                  ? `Start ${startableSelected.length} · ${selectedCount - startableSelected.length} will be skipped`
                  : `Start ${startableSelected.length} VM${startableSelected.length === 1 ? "" : "s"}`
            }
          >
            <span>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconPlayerPlay size={14} />}
                disabled={busy || startableSelected.length === 0}
                onClick={() =>
                  submitBulk("bulk-start", startableSelected, {
                    clientSkipped: selectedVms.length - startableSelected.length,
                  })
                }
              >
                Start
              </Button>
            </span>
          </Tooltip>
          <Tooltip
            label={
              stoppableSelected.length === 0
                ? "No selected VMs are eligible to stop"
                : selectedCount > stoppableSelected.length
                  ? `Stop ${stoppableSelected.length} · ${selectedCount - stoppableSelected.length} will be skipped`
                  : `Stop ${stoppableSelected.length} VM${stoppableSelected.length === 1 ? "" : "s"}`
            }
          >
            <span>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconPlayerStop size={14} />}
                disabled={busy || stoppableSelected.length === 0}
                onClick={() =>
                  submitBulk("bulk-stop", stoppableSelected, {
                    clientSkipped: selectedVms.length - stoppableSelected.length,
                  })
                }
              >
                Stop
              </Button>
            </span>
          </Tooltip>
          <Button
            size="xs"
            variant="light"
            color="red"
            leftSection={<IconTrash size={14} />}
            disabled={busy}
            onClick={() => {
              setBulkRetainDisks(false);
              setBulkDeleteOpen(true);
            }}
          >
            Delete
          </Button>
        </BulkActionBar>

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
                <Table.Th w={40}>
                  <Checkbox
                    aria-label="Select all visible VMs"
                    checked={allSelected}
                    indeterminate={someSelected}
                    disabled={busy}
                    onChange={() => toggleAllVisible()}
                  />
                </Table.Th>
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
                const key = resourceKey(vm);
                const ipv4 = displayAllocatedIpv4(vm.allocatedIpv4);
                return (
                  <Table.Tr
                    key={key}
                    bg={isSelected(key) ? "dark.7" : undefined}
                  >
                    <Table.Td>
                      <Checkbox
                        aria-label={`Select ${vm.name}`}
                        checked={isSelected(key)}
                        disabled={busy}
                        onChange={() => toggle(key)}
                      />
                    </Table.Td>
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
                        to={vmsListPath({
                          cluster: vm.cluster,
                          namespace: vm.namespace,
                        })}
                        dimmed
                      >
                        {vm.namespace}
                      </ResourceLink>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <ResourceLink
                          to={vmsListPath({
                            cluster: vm.cluster,
                            status: vm.status,
                          })}
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
                        <Text
                          size="sm"
                          ff="monospace"
                          c={ipv4 ? undefined : "dimmed"}
                        >
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
                            onClick={() => openDelete(vm)}
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
      </Stack>

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
        warning={
          retainDisks
            ? "The VirtualMachine will be removed; root DataVolumes stay in the namespace for reuse."
            : "Root DataVolumes referenced by this VM will also be deleted."
        }
        loading={busy}
        onClose={closeDelete}
        extra={
          <Radio.Group
            label="Disks"
            value={retainDisks ? "retain" : "destroy"}
            onChange={(v) => setRetainDisks(v === "retain")}
          >
            <Stack gap="xs" mt={6}>
              <Radio
                value="destroy"
                label="Delete VM and disks"
                description="Root DataVolumes will be deleted after the VM."
              />
              <Radio
                value="retain"
                label="Delete VM, keep disks"
                description="Root DataVolumes remain for reuse on launch."
              />
            </Stack>
          </Radio.Group>
        }
        onConfirm={() => {
          if (deleteTarget) {
            submitIntent("delete", deleteTarget, { retainDisks });
            closeDelete();
          }
        }}
      />

      <ConfirmBulkDeleteModal
        opened={bulkDeleteOpen}
        count={selectedVms.length}
        identities={bulkIdentities}
        title={`Delete ${selectedVms.length} virtual machine${selectedVms.length === 1 ? "" : "s"}`}
        confirmLabel={`Delete ${selectedVms.length} VM${selectedVms.length === 1 ? "" : "s"}`}
        warning={
          bulkRetainDisks
            ? "VirtualMachines will be removed; root DataVolumes stay in their namespaces for reuse."
            : "Root DataVolumes referenced by these VMs will also be deleted."
        }
        loading={busy}
        onClose={() => {
          setBulkDeleteOpen(false);
          setBulkRetainDisks(false);
        }}
        extra={
          <Radio.Group
            label="Disks"
            value={bulkRetainDisks ? "retain" : "destroy"}
            onChange={(v) => setBulkRetainDisks(v === "retain")}
          >
            <Stack gap="xs" mt={6}>
              <Radio
                value="destroy"
                label="Delete VMs and disks"
                description="Root DataVolumes will be deleted after each VM."
              />
              <Radio
                value="retain"
                label="Delete VMs, keep disks"
                description="Root DataVolumes remain for reuse on launch."
              />
            </Stack>
          </Radio.Group>
        }
        onConfirm={() => {
          submitBulk("bulk-delete", selectedVms, {
            retainDisks: bulkRetainDisks,
          });
        }}
      />
    </>
  );
}
