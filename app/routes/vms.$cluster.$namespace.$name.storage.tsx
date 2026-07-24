import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/vms.$cluster.$namespace.$name.storage";
import {
  ClampedText,
  ConfirmActionModal,
  ConfirmDeleteModal,
  DetailSection,
  ResourceLink,
} from "~/ui";
import { StatusBadge } from "~/ui/status-badge";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import { canRestoreVmSnapshot, formatAge, formatBytes } from "~/lib/format";
import type { VmSnapshotSummary } from "~/lib/types";
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

  return { snapshots };
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

export default function VmStorageTab({ loaderData }: Route.ComponentProps) {
  const { vm } = useVmDetail();
  const { snapshots } = loaderData;
  const fetcher = useFetcher<VmDetailActionResult>();
  const { refreshNow } = useRefresh();
  const [createSnapshotOpen, setCreateSnapshotOpen] = useState(false);
  const [snapshotNameInput, setSnapshotNameInput] = useState("");
  const [deleteSnapshotTarget, setDeleteSnapshotTarget] =
    useState<VmSnapshotSummary | null>(null);
  const [restoreSnapshotTarget, setRestoreSnapshotTarget] =
    useState<VmSnapshotSummary | null>(null);
  const busy = fetcher.state !== "idle";

  const intentBusy = (intent: string) =>
    busy && fetcher.formData?.get("intent") === intent;

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
      }
      refreshNow();
    }
  });

  return (
    <Stack gap="md">
      <DetailSection title="Volumes">
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
      </DetailSection>

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
    </Stack>
  );
}
