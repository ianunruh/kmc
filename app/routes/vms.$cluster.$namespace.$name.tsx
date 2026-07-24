import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Menu,
  Modal,
  Paper,
  Radio,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconCamera,
  IconChevronDown,
  IconEdit,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconTerminal2,
  IconTrash,
  IconWorldWww,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import type { Route } from "./+types/vms.$cluster.$namespace.$name";
import { StatusBadge } from "~/ui/status-badge";
import {
  ClampedText,
  ConfirmActionModal,
  ConfirmDeleteModal,
  EventsPanel,
  ResourceIdentity,
  ResourceLink,
  YamlPanel,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  canOpenConsole,
  canPause,
  canRestart,
  canRestoreVmSnapshot,
  canSoftReboot,
  canStart,
  canStop,
  canUnpause,
  dataVolumePath,
  floatingIpCreatePath,
  floatingIpsListPath,
  formatAge,
  formatBytes,
  formatDateTime,
  instanceTypePath,
  sizeLabel,
  vmConsolePath,
  vmEditPath,
  vmTerminalPath,
  vpcPath,
  vmsListPath,
} from "~/lib/format";
import { hasClusterPrometheus } from "~/lib/k8s/cluster-config.server";
import { listResourceEvents } from "~/lib/k8s/events.server";
import { getCustomObjectYaml } from "~/lib/k8s/yaml.server";
import type {
  FloatingIpSummary,
  VmLifecycleIntent,
  VmSnapshotSummary,
  VmVolumeInfo,
} from "~/lib/types";
import {
  deleteVm,
  getVm,
  pauseVm,
  restartVm,
  softRebootVm,
  startVm,
  stopVm,
  unpauseVm,
} from "~/vms/vms.server";
import {
  createVmRestore,
  createVmSnapshot,
  deleteVmSnapshot,
  listVmSnapshots,
} from "~/snapshots/snapshots.server";
import { disassociateFloatingIp, listFloatingIpsForVm } from "~/vpcs/vpcs.server";
import { VmMetricsPanel } from "~/vms/vm-metrics-panel";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { addressFromIpv4Annotation } from "~/lib/ipam/cidr";

function volumeHref(
  cluster: string,
  namespace: string,
  vol: VmVolumeInfo,
): string | null {
  if (!vol.linkName) return null;
  if (vol.kind !== "DataVolume" && vol.kind !== "PVC") return null;
  return dataVolumePath({ cluster, namespace, name: vol.linkName });
}

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "VM"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const [vm, events, yaml] = await Promise.all([
    getVm(cluster, namespace, name),
    listResourceEvents({
      cluster,
      namespace,
      name,
      kinds: ["VirtualMachine", "VirtualMachineInstance"],
    }),
    getCustomObjectYaml({
      cluster,
      group: "kubevirt.io",
      version: "v1",
      plural: "virtualmachines",
      namespace,
      name,
    }),
  ]);

  const privateAddrs = (vm.allocatedIpv4 ?? "")
    .split(",")
    .map((p) => addressFromIpv4Annotation(p.trim()) ?? p.trim())
    .filter(Boolean);
  let floatingIps: FloatingIpSummary[] = [];
  try {
    floatingIps = await listFloatingIpsForVm(cluster, namespace, name, privateAddrs);
  } catch {
    floatingIps = [];
  }

  let snapshots: VmSnapshotSummary[] = [];
  try {
    snapshots = await listVmSnapshots(cluster, namespace, name);
  } catch {
    snapshots = [];
  }

  // Prefill associate form: first Multus network that is a VPC
  const vpcPrefill = vm.networks.find((n) => n.vpc)?.vpc;

  return {
    vm,
    events,
    yaml,
    prometheusConfigured: hasClusterPrometheus(cluster),
    floatingIps,
    snapshots,
    vpcPrefill: vpcPrefill
      ? {
          cluster,
          namespace: vpcPrefill.namespace,
          name: vpcPrefill.name,
        }
      : null,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing path params" };
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "stop") {
      await stopVm(cluster, namespace, name);
      return { ok: true, intent };
    }
    if (intent === "start") {
      await startVm(cluster, namespace, name);
      return { ok: true, intent };
    }
    if (intent === "restart") {
      await restartVm(cluster, namespace, name);
      return { ok: true, intent };
    }
    if (intent === "softreboot") {
      await softRebootVm(cluster, namespace, name);
      return { ok: true, intent };
    }
    if (intent === "pause") {
      await pauseVm(cluster, namespace, name);
      return { ok: true, intent };
    }
    if (intent === "unpause") {
      await unpauseVm(cluster, namespace, name);
      return { ok: true, intent };
    }
    if (intent === "delete") {
      const retainDisks = form.get("retainDisks") === "true";
      const result = await deleteVm(cluster, namespace, name, { retainDisks });
      return {
        ok: true,
        intent,
        retainDisks,
        retainedDisks: result.retainedDisks,
      };
    }
    if (intent === "disassociate-fip") {
      const vpcName = String(form.get("vpcName") ?? "").trim();
      const idOrPublic = String(form.get("idOrPublic") ?? "").trim();
      if (!vpcName || !idOrPublic) {
        return { ok: false, error: "Missing floating IP identity", intent };
      }
      await disassociateFloatingIp({
        cluster,
        namespace,
        vpcName,
        idOrPublic,
      });
      return { ok: true, intent };
    }
    if (intent === "create-snapshot") {
      const snapshotName = String(form.get("snapshotName") ?? "").trim() || undefined;
      const result = await createVmSnapshot({
        cluster,
        namespace,
        vmName: name,
        name: snapshotName,
      });
      return { ok: true, intent, snapshotName: result.name };
    }
    if (intent === "delete-snapshot") {
      const snapshotName = String(form.get("snapshotName") ?? "").trim();
      if (!snapshotName) {
        return { ok: false, error: "Missing snapshot name", intent };
      }
      await deleteVmSnapshot(cluster, namespace, snapshotName);
      return { ok: true, intent, snapshotName };
    }
    if (intent === "restore-snapshot") {
      const snapshotName = String(form.get("snapshotName") ?? "").trim();
      if (!snapshotName) {
        return { ok: false, error: "Missing snapshot name", intent };
      }
      const result = await createVmRestore({
        cluster,
        namespace,
        vmName: name,
        snapshotName,
      });
      return { ok: true, intent, snapshotName, restoreName: result.name };
    }
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  } catch (err) {
    return actionFailure(`vm.${intent}`, err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Paper
      p="md"
      radius="sm"
      style={{
        background: "#12151a",
        border: "1px solid #1e242c",
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="sm">
        {title}
      </Text>
      {children}
    </Paper>
  );
}

function Field({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed" mb={2}>
        {label}
      </Text>
      {/* component="div" — Text defaults to <p>, which cannot wrap Badge/divs */}
      <Text component="div" size="sm" style={{ wordBreak: "break-word" }}>
        {value ?? "—"}
      </Text>
    </div>
  );
}

type ConfirmableLifecycleIntent = Extract<
  VmLifecycleIntent,
  "stop" | "restart" | "softreboot" | "pause"
>;

const LIFECYCLE_CONFIRM: Record<
  ConfirmableLifecycleIntent,
  { title: string; confirmLabel: string; message: string }
> = {
  stop: {
    title: "Stop virtual machine",
    confirmLabel: "Stop VM",
    message: "This will shut down the virtual machine.",
  },
  restart: {
    title: "Hard restart virtual machine",
    confirmLabel: "Hard restart",
    message:
      "This tears down the virt-launcher domain and starts a new one (hard restart).",
  },
  softreboot: {
    title: "Soft reboot virtual machine",
    confirmLabel: "Soft reboot",
    message:
      "This requests an ACPI reboot from the guest (soft reboot). Prefer when the guest agent is connected; use hard restart if the guest is unresponsive.",
  },
  pause: {
    title: "Pause virtual machine",
    confirmLabel: "Pause VM",
    message: "This will pause the virtual machine. It can be unpaused later.",
  },
};

function intentSuccessLabel(intent?: string): string {
  switch (intent) {
    case "softreboot":
      return "soft reboot";
    case "restart":
      return "hard restart";
    default:
      return intent ?? "action";
  }
}

type VmDetailActionResult = {
  ok?: boolean;
  error?: string;
  intent?: string;
  retainDisks?: boolean;
  retainedDisks?: string[];
  snapshotName?: string;
  restoreName?: string;
};

export default function VmDetailPage({ loaderData }: Route.ComponentProps) {
  const {
    vm,
    events,
    yaml,
    prometheusConfigured,
    floatingIps,
    snapshots,
    vpcPrefill,
  } = loaderData;
  const fetcher = useFetcher<VmDetailActionResult>();
  const navigate = useNavigate();
  const { refreshNow } = useRefresh();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [retainDisks, setRetainDisks] = useState(false);
  const [confirmIntent, setConfirmIntent] = useState<ConfirmableLifecycleIntent | null>(
    null,
  );
  const [disassociateTarget, setDisassociateTarget] = useState<FloatingIpSummary | null>(
    null,
  );
  const [createSnapshotOpen, setCreateSnapshotOpen] = useState(false);
  const [snapshotNameInput, setSnapshotNameInput] = useState("");
  const [deleteSnapshotTarget, setDeleteSnapshotTarget] =
    useState<VmSnapshotSummary | null>(null);
  const [restoreSnapshotTarget, setRestoreSnapshotTarget] =
    useState<VmSnapshotSummary | null>(null);
  const busy = fetcher.state !== "idle";

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error, {
        intent: data.intent,
        cluster: vm.cluster,
        namespace: vm.namespace,
        name: vm.name,
      });
      return;
    }
    if (data.ok) {
      if (data.intent === "delete") {
        if (data.retainDisks) {
          const disks = data.retainedDisks ?? [];
          notifyActionSuccess(
            "Done",
            disks.length > 0
              ? `VM deleted; disks retained: ${disks.join(", ")}`
              : "VM deleted; no owned disks were retained",
          );
        } else {
          notifyActionSuccess("Done", "VM delete requested");
        }
        navigate("/");
        return;
      }
      if (data.intent === "disassociate-fip") {
        notifyActionSuccess(
          "Done",
          "Floating IP disassociated — public address is held (not released)",
        );
      } else if (data.intent === "create-snapshot") {
        notifyActionSuccess(
          "Done",
          data.snapshotName
            ? `Snapshot ${data.snapshotName} created`
            : "Snapshot created",
        );
      } else if (data.intent === "delete-snapshot") {
        notifyActionSuccess(
          "Done",
          data.snapshotName
            ? `Snapshot ${data.snapshotName} deleted`
            : "Snapshot deleted",
        );
      } else if (data.intent === "restore-snapshot") {
        notifyActionSuccess(
          "Done",
          data.restoreName
            ? `Restore ${data.restoreName} started from ${data.snapshotName ?? "snapshot"}`
            : "Restore started",
        );
      } else {
        notifyActionSuccess("Done", `VM ${intentSuccessLabel(data.intent)} requested`);
      }
      refreshNow();
    }
  });

  function openDelete() {
    setRetainDisks(false);
    setDeleteOpen(true);
  }

  function closeDelete() {
    setRetainDisks(false);
    setDeleteOpen(false);
  }

  function submitIntent(intent: VmLifecycleIntent, options?: { retainDisks?: boolean }) {
    const payload: Record<string, string> = { intent };
    if (intent === "delete") {
      payload.retainDisks = options?.retainDisks ? "true" : "false";
    }
    fetcher.submit(payload, { method: "post" });
  }

  const intentBusy = (intent: string) =>
    busy && fetcher.formData?.get("intent") === intent;

  const confirmConfig = confirmIntent ? LIFECYCLE_CONFIRM[confirmIntent] : null;

  const interestingAnnotations = Object.entries(vm.annotations).filter(
    ([k]) =>
      !k.startsWith("kubectl.kubernetes.io/") &&
      !k.startsWith("kubevirt.io/latest") &&
      !k.startsWith("kubevirt.io/storage"),
  );

  const rootVolume =
    vm.volumes.find((v) => v.kind === "DataVolume" && v.linkName) ?? null;
  const rootVolumeHref = rootVolume
    ? volumeHref(vm.cluster, vm.namespace, rootVolume)
    : null;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Anchor component={Link} to="/" size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Virtual Machines
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              {vm.name}
            </Title>
            <ResourceLink
              to={vmsListPath({ cluster: vm.cluster, status: vm.status })}
              underline="never"
            >
              <StatusBadge status={vm.status} />
            </ResourceLink>
            {vm.ready && (
              <Badge size="sm" variant="outline" color="teal">
                ready
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            items={[
              { label: vm.cluster, to: vmsListPath({ cluster: vm.cluster }) },
              {
                label: vm.namespace,
                to: vmsListPath({ cluster: vm.cluster, namespace: vm.namespace }),
              },
            ]}
          />
        </div>
        <Group>
          <Button
            component={Link}
            to={vmTerminalPath(vm)}
            variant="default"
            leftSection={<IconTerminal2 size={16} />}
            disabled={!canOpenConsole(vm)}
            title={
              canOpenConsole(vm)
                ? "Open SSH terminal (platform console key)"
                : "Terminal requires a live VMI (Running)"
            }
          >
            Terminal
          </Button>
          <Button
            component={Link}
            to={vmConsolePath(vm)}
            variant="default"
            leftSection={<IconTerminal2 size={16} />}
            disabled={!canOpenConsole(vm)}
            title={
              canOpenConsole(vm)
                ? "Open serial console (boot / debug)"
                : "Serial console requires a live VMI (Running)"
            }
          >
            Serial
          </Button>
          <Button
            component={Link}
            to={vmEditPath(vm)}
            variant="default"
            leftSection={<IconEdit size={16} />}
          >
            Edit
          </Button>
          <Button
            variant="default"
            leftSection={<IconPlayerStop size={16} />}
            disabled={!canStop(vm) || busy}
            loading={intentBusy("stop")}
            title={vm.status === "Paused" ? "Unpause the VM before stopping" : undefined}
            onClick={() => setConfirmIntent("stop")}
          >
            Stop
          </Button>
          <Button
            variant="default"
            leftSection={<IconPlayerPlay size={16} />}
            disabled={!canStart(vm) || busy}
            loading={intentBusy("start")}
            onClick={() => submitIntent("start")}
          >
            Start
          </Button>
          <Menu shadow="md" width={220} position="bottom-end">
            <Menu.Target>
              <Button
                variant="default"
                leftSection={<IconRefresh size={16} />}
                rightSection={<IconChevronDown size={14} />}
                disabled={(!canRestart(vm) && !canSoftReboot(vm)) || busy}
                loading={intentBusy("restart") || intentBusy("softreboot")}
              >
                Restart
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconRefresh size={14} />}
                disabled={!canSoftReboot(vm) || busy}
                title={
                  canSoftReboot(vm)
                    ? "ACPI soft reboot (guest-initiated)"
                    : "Soft reboot requires a Running guest"
                }
                onClick={() => setConfirmIntent("softreboot")}
              >
                Soft reboot
              </Menu.Item>
              <Menu.Item
                leftSection={<IconRefresh size={14} />}
                disabled={!canRestart(vm) || busy}
                title="Tear down and recreate the domain"
                onClick={() => setConfirmIntent("restart")}
              >
                Hard restart
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          {canUnpause(vm) ? (
            <Button
              variant="default"
              leftSection={<IconPlayerPlay size={16} />}
              disabled={busy}
              loading={intentBusy("unpause")}
              onClick={() => submitIntent("unpause")}
            >
              Unpause
            </Button>
          ) : (
            <Button
              variant="default"
              leftSection={<IconPlayerPause size={16} />}
              disabled={!canPause(vm) || busy}
              loading={intentBusy("pause")}
              onClick={() => setConfirmIntent("pause")}
            >
              Pause
            </Button>
          )}
          <Button
            variant="default"
            leftSection={<IconCamera size={16} />}
            disabled={busy}
            loading={intentBusy("create-snapshot")}
            onClick={() => {
              setSnapshotNameInput("");
              setCreateSnapshotOpen(true);
            }}
          >
            Snapshot
          </Button>
          <Button
            color="red"
            variant="light"
            leftSection={<IconTrash size={16} />}
            disabled={busy}
            onClick={openDelete}
          >
            Delete
          </Button>
        </Group>
      </Group>

      {vm.restartRequired && (
        <Alert color="orange" variant="light" title="Restart required">
          {vm.restartRequiredMessage?.trim() ||
            "KubeVirt applied a LiveUpdate that still needs a guest reboot to take full effect."}{" "}
          Use Soft reboot when the guest agent is connected, or Hard restart if the guest
          is unresponsive.
        </Alert>
      )}

      {vm.message && (
        <Alert color="yellow" variant="light" title="Status message">
          {vm.message}
        </Alert>
      )}

      {prometheusConfigured && (
        <VmMetricsPanel cluster={vm.cluster} namespace={vm.namespace} name={vm.name} />
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailCard title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <Field
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
            <Field label="Age" value={formatAge(vm.age)} />
            <Field label="Created" value={formatDateTime(vm.age)} />
            <Field
              label="Cluster"
              value={
                <ResourceLink to={vmsListPath({ cluster: vm.cluster })} dimmed>
                  {vm.cluster}
                </ResourceLink>
              }
            />
            <Field
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
            <Field label="Node" value={vm.nodeName} />
            <Field label="Size" value={sizeLabel(vm)} />
            <Field
              label="Disk"
              value={
                vm.disk && rootVolumeHref ? (
                  <ResourceLink to={rootVolumeHref}>{vm.disk}</ResourceLink>
                ) : (
                  vm.disk
                )
              }
            />
            <Field
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
            <Field label="Preference" value={vm.preference} />
            <Field label="Run strategy" value={vm.runStrategy} />
            <Field label="Machine" value={vm.machineType} />
            <Field label="Architecture" value={vm.architecture} />
            <Field label="VMI phase" value={vm.vmiPhase ?? (vm.hasVmi ? "—" : "none")} />
            <Field label="IPv4 (live)" value={vm.ipv4Address} />
            <Field
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
            <Field label="UID" value={vm.uid ? <Code>{vm.uid}</Code> : undefined} />
          </SimpleGrid>
        </DetailCard>

        <DetailCard title="Guest agent">
          {!vm.hasVmi ? (
            <Text size="sm" c="dimmed">
              No live VMI — guest agent is only available while the VM is running.
            </Text>
          ) : (
            <Stack gap="sm">
              <SimpleGrid cols={2} spacing="sm">
                <Field
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
                <Field label="Hostname" value={vm.guestAgent?.hostname} />
                <Field
                  label="OS"
                  value={
                    vm.guestAgent?.osPrettyName || vm.guestAgent?.osName || undefined
                  }
                />
                <Field label="Version" value={vm.guestAgent?.osVersion} />
                <Field
                  label="Kernel"
                  value={
                    vm.guestAgent?.osKernelRelease ? (
                      <Code>{vm.guestAgent.osKernelRelease}</Code>
                    ) : undefined
                  }
                />
                <Field
                  label="Arch"
                  value={
                    vm.guestAgent?.osMachine ? (
                      <Code>{vm.guestAgent.osMachine}</Code>
                    ) : undefined
                  }
                />
                <Field label="Timezone" value={vm.guestAgent?.timezone} />
                <Field
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
              {vm.guestAgent?.filesystems && vm.guestAgent.filesystems.length > 0 ? (
                <div>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={6}>
                    Filesystems
                  </Text>
                  <Table.ScrollContainer
                    className="kmc-table-scroll"
                    minWidth={420}
                    type="native"
                  >
                    <Table className="kmc-table" verticalSpacing="xs" withRowBorders>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Mount</Table.Th>
                          <Table.Th>Type</Table.Th>
                          <Table.Th>Used</Table.Th>
                          <Table.Th>Total</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {vm.guestAgent.filesystems.map((fs) => {
                          const pct =
                            fs.totalBytes && fs.usedBytes != null && fs.totalBytes > 0
                              ? Math.round((fs.usedBytes / fs.totalBytes) * 100)
                              : null;
                          return (
                            <Table.Tr key={`${fs.mountPoint}-${fs.diskName ?? ""}`}>
                              <Table.Td>
                                <Code>{fs.mountPoint}</Code>
                                {fs.diskName ? (
                                  <Text size="xs" c="dimmed">
                                    {fs.diskName}
                                  </Text>
                                ) : null}
                              </Table.Td>
                              <Table.Td>
                                <Text size="sm" c="dimmed">
                                  {fs.fileSystemType ?? "—"}
                                </Text>
                              </Table.Td>
                              <Table.Td>
                                <Text size="sm">
                                  {formatBytes(fs.usedBytes)}
                                  {pct != null ? (
                                    <Text span size="xs" c="dimmed">
                                      {" "}
                                      ({pct}%)
                                    </Text>
                                  ) : null}
                                </Text>
                              </Table.Td>
                              <Table.Td>
                                <Text size="sm" c="dimmed">
                                  {formatBytes(fs.totalBytes)}
                                </Text>
                              </Table.Td>
                            </Table.Tr>
                          );
                        })}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </div>
              ) : null}
            </Stack>
          )}
          {vm.hasVmi && !vm.guestAgent?.connected && (
            <Text size="xs" c="dimmed" mt="sm">
              Install and enable qemu-guest-agent in the guest for soft reboot, hostname,
              filesystems, and richer OS info.
            </Text>
          )}
        </DetailCard>
      </SimpleGrid>

      <DetailCard title="Snapshots">
        <Group justify="space-between" mb="sm">
          <Text size="sm" c="dimmed">
            Point-in-time disk backups (KubeVirt VirtualMachineSnapshot). Online
            snapshots are more consistent when the guest agent is connected.
          </Text>
          <Button
            size="xs"
            variant="light"
            color="teal"
            leftSection={<IconPlus size={14} />}
            disabled={busy}
            loading={intentBusy("create-snapshot")}
            onClick={() => {
              setSnapshotNameInput("");
              setCreateSnapshotOpen(true);
            }}
          >
            Create snapshot
          </Button>
        </Group>
        {vm.hasVmi && !vm.guestAgent?.connected && (
          <Alert color="gray" variant="light" mb="sm" title="Guest agent not connected">
            Online snapshots will be crash-consistent (like a power-off). Install
            qemu-guest-agent for application-consistent freezes.
          </Alert>
        )}
        {snapshots.length === 0 ? (
          <Text size="sm" c="dimmed">
            No snapshots for this VM yet.
          </Text>
        ) : (
          <Table.ScrollContainer
            className="kmc-table-scroll"
            minWidth={640}
            type="native"
          >
            <Table className="kmc-table" verticalSpacing="xs" withRowBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Phase</Table.Th>
                  <Table.Th>Ready</Table.Th>
                  <Table.Th>Indications</Table.Th>
                  <Table.Th>Age</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {snapshots.map((snap) => (
                  <Table.Tr key={snap.name}>
                    <Table.Td>
                      <Code>{snap.name}</Code>
                      {snap.error ? (
                        <ClampedText size="xs" c="red" lineClamp={2} mt={2}>
                          {snap.error}
                        </ClampedText>
                      ) : null}
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge status={snap.phase} />
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        size="sm"
                        variant="light"
                        color={snap.readyToUse ? "teal" : "gray"}
                      >
                        {snap.readyToUse ? "yes" : "no"}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {snap.indications.length === 0 ? (
                        <Text size="sm" c="dimmed">
                          —
                        </Text>
                      ) : (
                        <Group gap={4}>
                          {snap.indications.map((ind) => (
                            <Badge
                              key={ind}
                              size="xs"
                              variant="outline"
                              color={
                                ind === "GuestAgent"
                                  ? "teal"
                                  : ind === "NoGuestAgent" || ind === "QuiesceFailed"
                                    ? "orange"
                                    : "gray"
                              }
                            >
                              {ind}
                            </Badge>
                          ))}
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {formatAge(snap.age)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="orange"
                          disabled={busy || !canRestoreVmSnapshot(snap)}
                          title={
                            canRestoreVmSnapshot(snap)
                              ? "Restore disks from this snapshot (VM will stop)"
                              : "Snapshot is not ready to restore"
                          }
                          onClick={() => setRestoreSnapshotTarget(snap)}
                        >
                          Restore
                        </Button>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="red"
                          disabled={busy}
                          onClick={() => setDeleteSnapshotTarget(snap)}
                        >
                          Delete
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </DetailCard>

      <DetailCard title="Floating IPs">
        <Group justify="space-between" mb="sm">
          <Text size="sm" c="dimmed">
            Public addresses mapped through a router external gateway to this VM.
          </Text>
          <Group gap="xs">
            <Button
              component={Link}
              to={floatingIpsListPath({
                cluster: vm.cluster,
                namespace: vm.namespace,
              })}
              size="xs"
              variant="subtle"
              leftSection={<IconWorldWww size={14} />}
            >
              All floating IPs
            </Button>
            {vpcPrefill && (
              <Button
                component={Link}
                to={floatingIpCreatePath({
                  cluster: vpcPrefill.cluster,
                  namespace: vpcPrefill.namespace,
                  vpc: vpcPrefill.name,
                  targetVm: vm.name,
                })}
                size="xs"
                variant="light"
                color="teal"
                leftSection={<IconPlus size={14} />}
              >
                Associate
              </Button>
            )}
          </Group>
        </Group>
        {floatingIps.length === 0 ? (
          <Text size="sm" c="dimmed">
            {vpcPrefill
              ? "No floating IPs associated with this VM."
              : "Attach this VM to a VPC whose shared router has an external gateway to use floating IPs."}
          </Text>
        ) : (
          <Table.ScrollContainer
            className="kmc-table-scroll"
            minWidth={480}
            type="native"
          >
            <Table className="kmc-table" verticalSpacing="xs" withRowBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Public</Table.Th>
                  <Table.Th>Private</Table.Th>
                  <Table.Th>VPC</Table.Th>
                  <Table.Th>Agent</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {floatingIps.map((f) => (
                  <Table.Tr key={`${f.vpcName}/${f.id}`}>
                    <Table.Td>
                      <Code>
                        {f.public}/{f.prefix}
                      </Code>
                    </Table.Td>
                    <Table.Td>
                      <Code>{f.private}</Code>
                    </Table.Td>
                    <Table.Td>
                      <ResourceLink
                        to={vpcPath({
                          cluster: f.cluster,
                          namespace: f.namespace,
                          name: f.vpcName,
                        })}
                      >
                        {f.vpcName}
                      </ResourceLink>
                    </Table.Td>
                    <Table.Td>
                      {f.agentStatus ? <StatusBadge status={f.agentStatus} /> : "—"}
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="orange"
                        disabled={busy}
                        onClick={() => setDisassociateTarget(f)}
                      >
                        Disassociate
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </DetailCard>

      <DetailCard title="Networks">
        {vm.networks.length === 0 ? (
          <Text size="sm" c="dimmed">
            No networks configured
          </Text>
        ) : (
          <Table.ScrollContainer
            className="kmc-table-scroll"
            minWidth={560}
            type="native"
          >
            <Table className="kmc-table" verticalSpacing="xs" withRowBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Guest NIC</Table.Th>
                  <Table.Th>Attachment</Table.Th>
                  <Table.Th>Binding</Table.Th>
                  <Table.Th>MAC</Table.Th>
                  <Table.Th>IPs</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {vm.networks.map((net) => (
                  <Table.Tr key={net.name}>
                    <Table.Td>
                      {net.name}
                      {net.linkState ? (
                        <Text size="xs" c="dimmed">
                          {net.linkState}
                        </Text>
                      ) : null}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {net.guestInterfaceName ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {net.multusNetworkName ? (
                        net.vpc ? (
                          <Group gap={4} wrap="nowrap">
                            <Text size="sm" component="span">
                              multus:
                            </Text>
                            <ResourceLink to={vpcPath(net.vpc)}>
                              {net.multusNetworkName}
                            </ResourceLink>
                          </Group>
                        ) : (
                          `multus:${net.multusNetworkName}`
                        )
                      ) : net.pod ? (
                        "pod"
                      ) : (
                        "—"
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {net.binding ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {net.mac ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {net.ipAddresses?.length ? net.ipAddresses.join(", ") : "—"}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </DetailCard>

      <DetailCard title="Volumes">
        {vm.volumes.length === 0 ? (
          <Text size="sm" c="dimmed">
            No volumes
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
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Kind</Table.Th>
                  <Table.Th>Detail</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th>Storage class</Table.Th>
                  <Table.Th>Bus</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {vm.volumes.map((vol) => {
                  const href = volumeHref(vm.cluster, vm.namespace, vol);
                  return (
                    <Table.Tr key={vol.name}>
                      <Table.Td>
                        {href ? (
                          <ResourceLink to={href}>{vol.name}</ResourceLink>
                        ) : (
                          vol.name
                        )}
                      </Table.Td>
                      <Table.Td>
                        {href ? (
                          <ResourceLink to={href} dimmed>
                            {vol.kind}
                          </ResourceLink>
                        ) : (
                          vol.kind
                        )}
                      </Table.Td>
                      <Table.Td>
                        <ClampedText size="sm" c="dimmed" lineClamp={2}>
                          {vol.detail ?? "—"}
                        </ClampedText>
                      </Table.Td>
                      <Table.Td>{vol.size ?? "—"}</Table.Td>
                      <Table.Td>{vol.storageClass ?? "—"}</Table.Td>
                      <Table.Td>{vol.diskBus ?? "—"}</Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </DetailCard>

      <DetailCard title="Conditions">
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
      </DetailCard>

      {(Object.keys(vm.labels).length > 0 || interestingAnnotations.length > 0) && (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          {Object.keys(vm.labels).length > 0 && (
            <DetailCard title="Labels">
              <Stack gap={6}>
                {Object.entries(vm.labels).map(([k, v]) => (
                  <Group key={k} gap="xs" wrap="nowrap" align="flex-start">
                    <Code>{k}</Code>
                    <Text size="sm" c="dimmed">
                      {v}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </DetailCard>
          )}
          {interestingAnnotations.length > 0 && (
            <DetailCard title="Annotations">
              <Stack gap={6}>
                {interestingAnnotations.map(([k, v]) => (
                  <div key={k}>
                    <Code>{k}</Code>
                    <Text size="sm" c="dimmed" mt={2} style={{ wordBreak: "break-all" }}>
                      {v}
                    </Text>
                  </div>
                ))}
              </Stack>
            </DetailCard>
          )}
        </SimpleGrid>
      )}

      <EventsPanel events={events} showKind />
      <YamlPanel yaml={yaml} />

      <ConfirmActionModal
        opened={confirmIntent != null}
        title={confirmConfig?.title ?? ""}
        confirmLabel={confirmConfig?.confirmLabel}
        message={
          <>
            {confirmConfig?.message}{" "}
            <Text span fw={700}>
              {vm.cluster}/{vm.namespace}/{vm.name}
            </Text>
          </>
        }
        loading={busy}
        onClose={() => setConfirmIntent(null)}
        onConfirm={() => {
          if (!confirmIntent) return;
          const intent = confirmIntent;
          setConfirmIntent(null);
          submitIntent(intent);
        }}
      />

      <ConfirmDeleteModal
        opened={deleteOpen}
        resourceName={vm.name}
        identity={`${vm.cluster}/${vm.namespace}/${vm.name}`}
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
          closeDelete();
          submitIntent("delete", { retainDisks });
        }}
      />

      <Modal
        opened={createSnapshotOpen}
        onClose={() => setCreateSnapshotOpen(false)}
        title="Create snapshot"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            Capture a point-in-time snapshot of{" "}
            <Text span fw={700}>
              {vm.cluster}/{vm.namespace}/{vm.name}
            </Text>
            . Leave the name empty to auto-generate one.
          </Text>
          {vm.hasVmi && !vm.guestAgent?.connected && (
            <Alert color="gray" variant="light" title="Crash-consistent">
              Guest agent is not connected — this online snapshot will not freeze
              filesystems.
            </Alert>
          )}
          <TextInput
            label="Snapshot name"
            description="DNS label; optional"
            placeholder="auto: {vm}-{timestamp}"
            value={snapshotNameInput}
            onChange={(e) => setSnapshotNameInput(e.currentTarget.value)}
            disabled={busy}
          />
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => setCreateSnapshotOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              loading={intentBusy("create-snapshot")}
              onClick={() => {
                setCreateSnapshotOpen(false);
                const payload: Record<string, string> = { intent: "create-snapshot" };
                const n = snapshotNameInput.trim();
                if (n) payload.snapshotName = n;
                fetcher.submit(payload, { method: "post" });
              }}
            >
              Create snapshot
            </Button>
          </Group>
        </Stack>
      </Modal>

      <ConfirmDeleteModal
        opened={deleteSnapshotTarget != null}
        resourceName={deleteSnapshotTarget?.name ?? ""}
        identity={
          deleteSnapshotTarget
            ? `${deleteSnapshotTarget.cluster}/${deleteSnapshotTarget.namespace}/${deleteSnapshotTarget.name}`
            : ""
        }
        title="Delete snapshot"
        confirmLabel="Delete snapshot"
        warning="Volume snapshots backing this backup will be removed according to the VolumeSnapshotClass deletion policy."
        loading={busy}
        onClose={() => setDeleteSnapshotTarget(null)}
        onConfirm={() => {
          if (!deleteSnapshotTarget) return;
          const snapshotName = deleteSnapshotTarget.name;
          setDeleteSnapshotTarget(null);
          fetcher.submit(
            { intent: "delete-snapshot", snapshotName },
            { method: "post" },
          );
        }}
      />

      <ConfirmActionModal
        opened={restoreSnapshotTarget != null}
        onClose={() => setRestoreSnapshotTarget(null)}
        title="Restore from snapshot"
        confirmLabel="Restore"
        confirmColor="orange"
        loading={busy}
        message={
          <>
            Disk contents of{" "}
            <Text span fw={700}>
              {vm.cluster}/{vm.namespace}/{vm.name}
            </Text>{" "}
            will roll back to snapshot{" "}
            <Text span fw={700}>
              {restoreSnapshotTarget?.name}
            </Text>
            . The VM will be stopped if it is running. Network identity and IPAM
            annotations are kept.
          </>
        }
        onConfirm={() => {
          if (!restoreSnapshotTarget) return;
          const snapshotName = restoreSnapshotTarget.name;
          setRestoreSnapshotTarget(null);
          fetcher.submit(
            { intent: "restore-snapshot", snapshotName },
            { method: "post" },
          );
        }}
      />

      <ConfirmActionModal
        opened={disassociateTarget != null}
        onClose={() => setDisassociateTarget(null)}
        title="Disassociate floating IP"
        confirmLabel="Disassociate"
        confirmColor="orange"
        loading={busy}
        onConfirm={() => {
          if (!disassociateTarget) return;
          fetcher.submit(
            {
              intent: "disassociate-fip",
              vpcName: disassociateTarget.vpcName,
              idOrPublic: disassociateTarget.id,
            },
            { method: "post" },
          );
          setDisassociateTarget(null);
        }}
        message={
          disassociateTarget ? (
            <>
              Unmap{" "}
              <Code>
                {disassociateTarget.public} → {disassociateTarget.private}
              </Code>{" "}
              on VPC <Code>{disassociateTarget.vpcName}</Code>? The public address stays
              reserved (held) until released from the floating IPs list or VPC page.
            </>
          ) : (
            ""
          )
        }
      />
    </Stack>
  );
}
