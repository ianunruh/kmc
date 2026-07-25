import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  NumberInput,
  Radio,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/vms.$cluster.$namespace.$name.storage";
import {
  ClampedText,
  ConfirmActionModal,
  ConfirmDeleteModal,
  DetailField,
  DetailSection,
  ResourceLink,
} from "~/ui";
import { StatusBadge } from "~/ui/status-badge";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  canRestoreVmSnapshot,
  formatAge,
  formatBytes,
  formatDateTime,
} from "~/lib/format";
import { KMC_MAX_EXTRA_DISKS } from "~/lib/k8s/constants";
import type {
  ClusterCatalog,
  VmDiskSourceMode,
  VmSnapshotScheduleSummary,
  VmSnapshotSummary,
  VmVolumeInfo,
} from "~/lib/types";
import {
  cronPresetLabel,
  SNAPSHOT_SCHEDULE_PRESETS,
  SNAPSHOT_SCHEDULE_RETAIN_DEFAULT,
  SNAPSHOT_SCHEDULE_RETAIN_MAX,
  SNAPSHOT_SCHEDULE_RETAIN_MIN,
} from "~/snapshots/schedule-constants";
import {
  deleteVmSnapshotSchedule,
  getVmSnapshotSchedule,
  upsertVmSnapshotSchedule,
} from "~/snapshots/schedules.server";
import {
  createVmRestore,
  createVmSnapshot,
  deleteVmSnapshot,
  listVmSnapshots,
} from "~/snapshots/snapshots.server";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import {
  useVmDetail,
  volumeHref,
  type VmDetailActionResult,
} from "~/vms/vm-detail-shared";
import { attachVmDisk, detachVmDisk } from "~/vms/vms.server";

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  let snapshots: VmSnapshotSummary[] = [];
  try {
    snapshots = await listVmSnapshots(cluster, namespace, name);
  } catch {
    snapshots = [];
  }

  let schedule: VmSnapshotScheduleSummary | null = null;
  try {
    schedule = await getVmSnapshotSchedule(cluster, namespace, name);
  } catch {
    schedule = null;
  }

  return { snapshots, schedule };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing path params" };
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
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
    if (intent === "upsert-snapshot-schedule") {
      const cron = String(form.get("cron") ?? "").trim();
      const retainRaw = Number(form.get("retain"));
      const retain = Number.isFinite(retainRaw)
        ? Math.trunc(retainRaw)
        : SNAPSHOT_SCHEDULE_RETAIN_DEFAULT;
      const enabled = form.get("enabled") !== "false";
      const failureDeadline =
        String(form.get("failureDeadline") ?? "").trim() || undefined;
      const result = await upsertVmSnapshotSchedule({
        cluster,
        namespace,
        vmName: name,
        cron,
        retain,
        enabled,
        failureDeadline,
      });
      return {
        ok: true,
        intent,
        scheduleName: result.name,
        scheduleEnabled: result.enabled,
      };
    }
    if (intent === "delete-snapshot-schedule") {
      await deleteVmSnapshotSchedule(cluster, namespace, name);
      return { ok: true, intent };
    }
    if (intent === "attach-disk") {
      const sourceRaw = String(form.get("source") ?? "blank").trim();
      const source: VmDiskSourceMode =
        sourceRaw === "existingDataVolume" ? "existingDataVolume" : "blank";
      const volumeName = String(form.get("volumeName") ?? "").trim() || undefined;
      const size = String(form.get("size") ?? "").trim() || undefined;
      const storageClass =
        String(form.get("storageClass") ?? "").trim() || undefined;
      const existingDataVolumeName =
        String(form.get("existingDataVolumeName") ?? "").trim() || undefined;
      const result = await attachVmDisk({
        cluster,
        namespace,
        vmName: name,
        name: volumeName,
        source,
        size,
        storageClass,
        existingDataVolumeName,
      });
      return {
        ok: true,
        intent,
        volumeName: result.volumeName,
        dataVolumeName: result.dataVolumeName,
        createdDataVolume: result.createdDataVolume,
      };
    }
    if (intent === "detach-disk") {
      const volumeName = String(form.get("volumeName") ?? "").trim();
      if (!volumeName) {
        return { ok: false, error: "Missing volume name", intent };
      }
      const deleteDisk = form.get("deleteDisk") === "true";
      const result = await detachVmDisk({
        cluster,
        namespace,
        vmName: name,
        volumeName,
        deleteDisk,
      });
      return {
        ok: true,
        intent,
        volumeName: result.volumeName,
        dataVolumeName: result.dataVolumeName,
        deletedDataVolume: result.deletedDataVolume,
        retainedDataVolume: result.retainedDataVolume,
      };
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

type DataVolumesFetcherData = {
  dataVolumes: Array<{
    name: string;
    phase: string;
    size?: string;
    retainedFromVm?: string;
  }>;
};

const SCHEDULE_PRESET_OPTIONS = [
  ...SNAPSHOT_SCHEDULE_PRESETS.map((p) => ({ value: p.value, label: p.label })),
  { value: "custom", label: "Custom cron…" },
];

function schedulePresetValue(cron: string): string {
  return SNAPSHOT_SCHEDULE_PRESETS.some((p) => p.value === cron) ? cron : "custom";
}

export default function VmStorageTab({ loaderData }: Route.ComponentProps) {
  const { vm } = useVmDetail();
  const { snapshots, schedule } = loaderData;
  const fetcher = useFetcher<VmDetailActionResult>();
  const catalogFetcher = useFetcher<ClusterCatalog>();
  const dataVolumesFetcher = useFetcher<DataVolumesFetcherData>();
  const { refreshNow } = useRefresh();
  const [createSnapshotOpen, setCreateSnapshotOpen] = useState(false);
  const [snapshotNameInput, setSnapshotNameInput] = useState("");
  const [deleteSnapshotTarget, setDeleteSnapshotTarget] =
    useState<VmSnapshotSummary | null>(null);
  const [restoreSnapshotTarget, setRestoreSnapshotTarget] =
    useState<VmSnapshotSummary | null>(null);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleDeleteOpen, setScheduleDeleteOpen] = useState(false);
  const [schedulePreset, setSchedulePreset] = useState("0 3 * * *");
  const [scheduleCronCustom, setScheduleCronCustom] = useState("0 3 * * *");
  const [scheduleRetain, setScheduleRetain] = useState<number | string>(
    SNAPSHOT_SCHEDULE_RETAIN_DEFAULT,
  );
  const [scheduleEnabled, setScheduleEnabled] = useState(true);
  const [addDiskOpen, setAddDiskOpen] = useState(false);
  const [diskSource, setDiskSource] = useState<VmDiskSourceMode>("blank");
  const [diskVolumeName, setDiskVolumeName] = useState("");
  const [diskSize, setDiskSize] = useState("10Gi");
  const [diskStorageClass, setDiskStorageClass] = useState("");
  const [diskExistingDv, setDiskExistingDv] = useState("");
  const [detachTarget, setDetachTarget] = useState<VmVolumeInfo | null>(null);
  const [detachDeleteDisk, setDetachDeleteDisk] = useState(false);
  const busy = fetcher.state !== "idle";

  const secondaryCount = useMemo(
    () => vm.volumes.filter((v) => v.canDetach).length,
    [vm.volumes],
  );
  const canAddDisk = secondaryCount < KMC_MAX_EXTRA_DISKS;

  const intentBusy = (intent: string) =>
    busy && fetcher.formData?.get("intent") === intent;

  useEffect(() => {
    if (!addDiskOpen) return;
    if (catalogFetcher.state === "idle" && !catalogFetcher.data) {
      catalogFetcher.load(`/api/catalog/${encodeURIComponent(vm.cluster)}`);
    }
    if (diskSource === "existingDataVolume") {
      dataVolumesFetcher.load(
        `/api/datavolumes/${encodeURIComponent(vm.cluster)}?namespace=${encodeURIComponent(vm.namespace)}`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addDiskOpen, diskSource, vm.cluster, vm.namespace]);

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
      if (data.intent === "create-snapshot") {
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
      } else if (data.intent === "upsert-snapshot-schedule") {
        notifyActionSuccess(
          "Done",
          data.scheduleEnabled === false
            ? "Snapshot schedule saved (paused)"
            : "Snapshot schedule saved",
        );
      } else if (data.intent === "delete-snapshot-schedule") {
        notifyActionSuccess("Done", "Snapshot schedule removed");
      } else if (data.intent === "attach-disk") {
        notifyActionSuccess(
          "Done",
          data.volumeName
            ? `Disk ${data.volumeName} attached` +
                (data.dataVolumeName ? ` (${data.dataVolumeName})` : "")
            : "Disk attached",
        );
      } else if (data.intent === "detach-disk") {
        const bits = [
          data.volumeName ? `Detached ${data.volumeName}` : "Disk detached",
        ];
        if (data.deletedDataVolume && data.dataVolumeName) {
          bits.push(`deleted DataVolume ${data.dataVolumeName}`);
        } else if (data.retainedDataVolume && data.dataVolumeName) {
          bits.push(`kept DataVolume ${data.dataVolumeName}`);
        } else if (data.dataVolumeName) {
          bits.push(`DataVolume ${data.dataVolumeName} left in namespace`);
        }
        notifyActionSuccess("Done", bits.join(" — "));
      }
      refreshNow();
    }
  });

  const storageOptions = useMemo(() => {
    const classes = catalogFetcher.data?.storageClasses ?? [];
    return classes.map((sc) => ({
      value: sc.name,
      label: sc.isDefault ? `${sc.name} (default)` : sc.name,
    }));
  }, [catalogFetcher.data]);

  const dataVolumeOptions = useMemo(() => {
    const items = dataVolumesFetcher.data?.dataVolumes ?? [];
    return items.map((dv) => {
      const bits = [dv.name];
      if (dv.size) bits.push(dv.size);
      if (dv.retainedFromVm) bits.push(`retained from ${dv.retainedFromVm}`);
      return {
        value: dv.name,
        label: bits.length > 1 ? `${bits[0]} (${bits.slice(1).join(" · ")})` : bits[0]!,
      };
    });
  }, [dataVolumesFetcher.data]);

  const openAddDisk = () => {
    setDiskSource("blank");
    setDiskVolumeName("");
    setDiskSize("10Gi");
    setDiskStorageClass(catalogFetcher.data?.defaultStorageClass ?? "");
    setDiskExistingDv("");
    setAddDiskOpen(true);
  };

  const openScheduleModal = () => {
    if (schedule) {
      setSchedulePreset(schedulePresetValue(schedule.cron));
      setScheduleCronCustom(schedule.cron);
      setScheduleRetain(schedule.retain);
      setScheduleEnabled(schedule.enabled);
    } else {
      setSchedulePreset("0 3 * * *");
      setScheduleCronCustom("0 3 * * *");
      setScheduleRetain(SNAPSHOT_SCHEDULE_RETAIN_DEFAULT);
      setScheduleEnabled(true);
    }
    setScheduleModalOpen(true);
  };

  const resolvedScheduleCron =
    schedulePreset === "custom" ? scheduleCronCustom.trim() : schedulePreset;

  const scheduleCronLabel = schedule
    ? cronPresetLabel(schedule.cron) ?? schedule.cron
    : null;

  return (
    <Stack gap="md">
      <DetailSection
        title="Volumes"
        actions={
          <Button
            size="xs"
            variant="light"
            color="teal"
            leftSection={<IconPlus size={14} />}
            disabled={busy || !canAddDisk}
            loading={intentBusy("attach-disk")}
            title={
              canAddDisk
                ? "Attach a blank or existing DataVolume"
                : `At most ${KMC_MAX_EXTRA_DISKS} secondary disks`
            }
            onClick={openAddDisk}
          >
            Add disk
          </Button>
        }
      >
        <Text size="sm" c="dimmed" mb="sm">
          Secondary disks use scsi (hotplug-friendly). New volumes appear as
          unformatted block devices — partition and mount inside the guest.
        </Text>
        {vm.volumes.length === 0 ? (
          <Text size="sm" c="dimmed">
            No volumes
          </Text>
        ) : (
          <Table.ScrollContainer
            className="kmc-table-scroll"
            minWidth={800}
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
                  <Table.Th>Phase</Table.Th>
                  <Table.Th />
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
                        {vol.isRoot ? (
                          <Badge size="xs" variant="outline" ml={6}>
                            root
                          </Badge>
                        ) : null}
                        {vol.hotpluggable ? (
                          <Badge size="xs" variant="light" color="teal" ml={6}>
                            hotplug
                          </Badge>
                        ) : null}
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
                      <Table.Td>
                        {vol.volumePhase ? (
                          <StatusBadge status={vol.volumePhase} />
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {vol.canDetach ? (
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            color="red"
                            disabled={busy}
                            onClick={() => {
                              setDetachDeleteDisk(false);
                              setDetachTarget(vol);
                            }}
                          >
                            Detach
                          </Button>
                        ) : null}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </DetailSection>

      <DetailSection title="Filesystems">
        {!vm.hasVmi ? (
          <Text size="sm" c="dimmed">
            No live VMI — guest filesystems are only available while the VM is running.
          </Text>
        ) : !vm.guestAgent?.connected ? (
          <Text size="sm" c="dimmed">
            Guest agent is not connected. Install and enable qemu-guest-agent to report
            mount points and usage.
          </Text>
        ) : !vm.guestAgent.filesystems?.length ? (
          <Text size="sm" c="dimmed">
            No filesystem info reported by the guest agent.
          </Text>
        ) : (
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
        )}
      </DetailSection>

      <DetailSection
        title="Snapshot schedule"
        actions={
          <Group gap={6}>
            {schedule ? (
              <>
                <Button
                  size="xs"
                  variant="light"
                  disabled={busy}
                  loading={intentBusy("upsert-snapshot-schedule")}
                  onClick={openScheduleModal}
                >
                  Edit schedule
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  disabled={busy}
                  loading={intentBusy("delete-snapshot-schedule")}
                  onClick={() => setScheduleDeleteOpen(true)}
                >
                  Remove
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="light"
                color="teal"
                leftSection={<IconPlus size={14} />}
                disabled={busy}
                loading={intentBusy("upsert-snapshot-schedule")}
                onClick={openScheduleModal}
              >
                Enable schedule
              </Button>
            )}
          </Group>
        }
      >
        <Text size="sm" c="dimmed" mb="sm">
          Automated KubeVirt snapshots via a Kubernetes CronJob in this
          namespace. Retention prunes only scheduled snapshots (manual ones are
          kept). Jobs use{" "}
          <Code>ghcr.io/ianunruh/kmc:latest</Code> (override with{" "}
          <Code>KMC_SNAPSHOT_JOB_IMAGE</Code>).
        </Text>
        {!schedule ? (
          <Text size="sm" c="dimmed">
            No schedule configured for this VM.
          </Text>
        ) : (
          <Stack gap="sm">
            <Group gap="lg" wrap="wrap">
              <DetailField
                label="Status"
                value={
                  <Badge
                    size="sm"
                    variant="light"
                    color={schedule.enabled ? "teal" : "gray"}
                  >
                    {schedule.enabled ? "Active" : "Paused"}
                  </Badge>
                }
              />
              <DetailField
                label="Cadence"
                value={
                  <Text size="sm">
                    {scheduleCronLabel}
                    {cronPresetLabel(schedule.cron) ? (
                      <Text span size="xs" c="dimmed" ml={6}>
                        ({schedule.cron})
                      </Text>
                    ) : null}
                  </Text>
                }
              />
              <DetailField label="Retain" value={`${schedule.retain} scheduled`} />
              <DetailField
                label="CronJob"
                value={<Code>{schedule.cronJobName}</Code>}
              />
            </Group>
            <Group gap="lg" wrap="wrap">
              <DetailField
                label="Last run"
                value={
                  schedule.lastRunAt ? formatDateTime(schedule.lastRunAt) : "—"
                }
              />
              <DetailField
                label="Last success"
                value={
                  schedule.lastSuccessAt
                    ? formatDateTime(schedule.lastSuccessAt)
                    : "—"
                }
              />
              <DetailField
                label="Last snapshot"
                value={
                  schedule.lastSnapshot ? (
                    <Code>{schedule.lastSnapshot}</Code>
                  ) : (
                    "—"
                  )
                }
              />
            </Group>
            {schedule.lastError ? (
              <Alert color="orange" variant="light" title="Last run note">
                <ClampedText size="sm" lineClamp={3}>
                  {schedule.lastError}
                </ClampedText>
              </Alert>
            ) : null}
            {schedule.lastPruned ? (
              <Text size="xs" c="dimmed">
                Last pruned: {schedule.lastPruned}
              </Text>
            ) : null}
          </Stack>
        )}
      </DetailSection>

      <DetailSection
        title="Snapshots"
        actions={
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
        }
      >
        <Text size="sm" c="dimmed" mb="sm">
          Point-in-time disk backups (KubeVirt VirtualMachineSnapshot). Online
          snapshots are more consistent when the guest agent is connected.
          Attached secondary disks are included.
        </Text>
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
            minWidth={700}
            type="native"
          >
            <Table className="kmc-table" verticalSpacing="xs" withRowBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Kind</Table.Th>
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
                      <Badge
                        size="sm"
                        variant="light"
                        color={
                          snap.snapshotKind === "scheduled" || snap.scheduleName
                            ? "violet"
                            : "gray"
                        }
                      >
                        {snap.snapshotKind === "scheduled" || snap.scheduleName
                          ? "scheduled"
                          : "manual"}
                      </Badge>
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
      </DetailSection>

      <Modal
        opened={addDiskOpen}
        onClose={() => setAddDiskOpen(false)}
        title="Add disk"
        centered
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Attach a persistent secondary disk to{" "}
            <Text span fw={700}>
              {vm.name}
            </Text>
            . Updates the VirtualMachine spec (declarative hotplug); the guest
            sees it live when running, or on next start when stopped.
          </Text>
          <SegmentedControl
            fullWidth
            value={diskSource}
            onChange={(v) => setDiskSource(v as VmDiskSourceMode)}
            data={[
              { label: "New blank disk", value: "blank" },
              { label: "Existing DataVolume", value: "existingDataVolume" },
            ]}
            disabled={busy}
          />
          <TextInput
            label="Volume name"
            description="Optional DNS label; default disk-1, disk-2, …"
            placeholder="disk-1"
            value={diskVolumeName}
            onChange={(e) => setDiskVolumeName(e.currentTarget.value)}
            disabled={busy}
          />
          {diskSource === "blank" ? (
            <>
              <TextInput
                label="Size"
                placeholder="10Gi"
                required
                value={diskSize}
                onChange={(e) => setDiskSize(e.currentTarget.value)}
                disabled={busy}
              />
              <Select
                label="Storage class"
                placeholder="Cluster default"
                clearable
                data={storageOptions}
                value={diskStorageClass || null}
                onChange={(v) => setDiskStorageClass(v ?? "")}
                disabled={busy || catalogFetcher.state === "loading"}
                nothingFoundMessage="No storage classes"
              />
            </>
          ) : (
            <Select
              label="DataVolume"
              placeholder="Select reusable DataVolume"
              searchable
              required
              data={dataVolumeOptions}
              value={diskExistingDv || null}
              onChange={(v) => setDiskExistingDv(v ?? "")}
              disabled={busy || dataVolumesFetcher.state === "loading"}
              nothingFoundMessage="No reusable DataVolumes in this namespace"
            />
          )}
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => setAddDiskOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              loading={intentBusy("attach-disk")}
              onClick={() => {
                if (diskSource === "blank" && !diskSize.trim()) return;
                if (diskSource === "existingDataVolume" && !diskExistingDv.trim()) {
                  return;
                }
                setAddDiskOpen(false);
                const payload: Record<string, string> = {
                  intent: "attach-disk",
                  source: diskSource,
                };
                if (diskVolumeName.trim()) payload.volumeName = diskVolumeName.trim();
                if (diskSource === "blank") {
                  payload.size = diskSize.trim();
                  if (diskStorageClass.trim()) {
                    payload.storageClass = diskStorageClass.trim();
                  }
                } else {
                  payload.existingDataVolumeName = diskExistingDv.trim();
                }
                fetcher.submit(payload, { method: "post" });
              }}
            >
              Attach disk
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={detachTarget != null}
        onClose={() => setDetachTarget(null)}
        title="Detach disk"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            Detach volume{" "}
            <Text span fw={700}>
              {detachTarget?.name}
            </Text>
            {detachTarget?.linkName ? (
              <>
                {" "}
                (DataVolume{" "}
                <Code>{detachTarget.linkName}</Code>)
              </>
            ) : null}{" "}
            from this VM.
          </Text>
          <Radio.Group
            value={detachDeleteDisk ? "delete" : "keep"}
            onChange={(v) => setDetachDeleteDisk(v === "delete")}
          >
            <Stack gap="xs">
              <Radio
                value="keep"
                label="Detach and keep DataVolume"
                description="Disk remains in the namespace for reuse"
              />
              <Radio
                value="delete"
                label="Detach and delete DataVolume"
                description="Permanently remove the backing disk"
              />
            </Stack>
          </Radio.Group>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => setDetachTarget(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              color="red"
              loading={intentBusy("detach-disk")}
              onClick={() => {
                if (!detachTarget) return;
                const volumeName = detachTarget.name;
                const deleteDisk = detachDeleteDisk;
                setDetachTarget(null);
                fetcher.submit(
                  {
                    intent: "detach-disk",
                    volumeName,
                    deleteDisk: deleteDisk ? "true" : "false",
                  },
                  { method: "post" },
                );
              }}
            >
              Detach
            </Button>
          </Group>
        </Stack>
      </Modal>

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
        title="Restore snapshot"
        confirmLabel="Restore"
        confirmColor="orange"
        loading={busy}
        message={
          restoreSnapshotTarget ? (
            <>
              Restore{" "}
              <Text span fw={700}>
                {restoreSnapshotTarget.name}
              </Text>{" "}
              onto this VM in-place. The VM will be stopped if running. This
              overwrites current disk contents.
            </>
          ) : (
            ""
          )
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

      <Modal
        opened={scheduleModalOpen}
        onClose={() => setScheduleModalOpen(false)}
        title={schedule ? "Edit snapshot schedule" : "Enable snapshot schedule"}
        centered
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Creates a CronJob that runs the kmc snapshot worker on a schedule
            (UTC). Only scheduled snapshots count toward retention; manual
            snapshots are never auto-deleted.
          </Text>
          <Select
            label="Cadence"
            data={SCHEDULE_PRESET_OPTIONS}
            value={schedulePreset}
            onChange={(v) => {
              const next = v ?? "0 3 * * *";
              setSchedulePreset(next);
              if (next !== "custom") {
                setScheduleCronCustom(next);
              }
            }}
            disabled={busy}
            allowDeselect={false}
          />
          {schedulePreset === "custom" ? (
            <TextInput
              label="Cron expression"
              description="Standard 5-field cron (minute hour day month weekday), UTC"
              placeholder="0 3 * * *"
              value={scheduleCronCustom}
              onChange={(e) => setScheduleCronCustom(e.currentTarget.value)}
              disabled={busy}
              required
            />
          ) : null}
          <NumberInput
            label="Retain"
            description={`Keep the newest N scheduled snapshots (${SNAPSHOT_SCHEDULE_RETAIN_MIN}–${SNAPSHOT_SCHEDULE_RETAIN_MAX})`}
            min={SNAPSHOT_SCHEDULE_RETAIN_MIN}
            max={SNAPSHOT_SCHEDULE_RETAIN_MAX}
            value={scheduleRetain}
            onChange={setScheduleRetain}
            disabled={busy}
            allowDecimal={false}
          />
          <Switch
            label="Schedule enabled"
            description="When off, the CronJob is suspended (no new snapshots)"
            checked={scheduleEnabled}
            onChange={(e) => setScheduleEnabled(e.currentTarget.checked)}
            disabled={busy}
          />
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => setScheduleModalOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              loading={intentBusy("upsert-snapshot-schedule")}
              onClick={() => {
                const retainNum =
                  typeof scheduleRetain === "number"
                    ? scheduleRetain
                    : Number(scheduleRetain);
                if (!resolvedScheduleCron) return;
                if (
                  !Number.isFinite(retainNum) ||
                  retainNum < SNAPSHOT_SCHEDULE_RETAIN_MIN ||
                  retainNum > SNAPSHOT_SCHEDULE_RETAIN_MAX
                ) {
                  return;
                }
                setScheduleModalOpen(false);
                fetcher.submit(
                  {
                    intent: "upsert-snapshot-schedule",
                    cron: resolvedScheduleCron,
                    retain: String(Math.trunc(retainNum)),
                    enabled: scheduleEnabled ? "true" : "false",
                  },
                  { method: "post" },
                );
              }}
            >
              Save schedule
            </Button>
          </Group>
        </Stack>
      </Modal>

      <ConfirmDeleteModal
        opened={scheduleDeleteOpen}
        resourceName={schedule?.name ?? "schedule"}
        identity={
          schedule
            ? `${schedule.cluster}/${schedule.namespace}/${schedule.name}`
            : ""
        }
        title="Remove snapshot schedule"
        confirmLabel="Remove schedule"
        warning="Deletes the CronJob and schedule ConfigMap. Existing VirtualMachineSnapshots are left in place."
        loading={busy}
        onClose={() => setScheduleDeleteOpen(false)}
        onConfirm={() => {
          setScheduleDeleteOpen(false);
          fetcher.submit(
            { intent: "delete-snapshot-schedule" },
            { method: "post" },
          );
        }}
      />
    </Stack>
  );
}
