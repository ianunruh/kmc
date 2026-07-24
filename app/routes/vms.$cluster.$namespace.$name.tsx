import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  Radio,
  Stack,
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
  IconRefresh,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, Outlet, useFetcher, useNavigate } from "react-router";
import type { Route } from "./+types/vms.$cluster.$namespace.$name";
import { StatusBadge } from "~/ui/status-badge";
import {
  ConfirmActionModal,
  ConfirmDeleteModal,
  DetailTabs,
  ResourceIdentity,
  ResourceLink,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  canOpenConsole,
  canPause,
  canRestart,
  canSoftReboot,
  canStart,
  canStop,
  canUnpause,
  vmConsolePath,
  vmEditPath,
  vmTabPath,
  vmTerminalPath,
  vmsListPath,
} from "~/lib/format";
import { hasClusterPrometheus } from "~/lib/k8s/cluster-config.server";
import type { VmLifecycleIntent } from "~/lib/types";
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
import { createVmSnapshot } from "~/snapshots/snapshots.server";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import {
  intentSuccessLabel,
  type VmDetailActionResult,
} from "~/vms/vm-detail-shared";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "VM"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const vm = await getVm(cluster, namespace, name);
  return {
    vm,
    prometheusConfigured: hasClusterPrometheus(cluster),
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

export default function VmDetailLayout({ loaderData }: Route.ComponentProps) {
  const { vm } = loaderData;
  const fetcher = useFetcher<VmDetailActionResult>();
  const navigate = useNavigate();
  const { refreshNow } = useRefresh();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [retainDisks, setRetainDisks] = useState(false);
  const [confirmIntent, setConfirmIntent] = useState<ConfirmableLifecycleIntent | null>(
    null,
  );
  const [createSnapshotOpen, setCreateSnapshotOpen] = useState(false);
  const [snapshotNameInput, setSnapshotNameInput] = useState("");
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
      if (data.intent === "create-snapshot") {
        notifyActionSuccess(
          "Done",
          data.snapshotName
            ? `Snapshot ${data.snapshotName} created`
            : "Snapshot created",
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

      <DetailTabs
        items={[
          { label: "Overview", to: vmTabPath(vm, "overview"), end: true },
          { label: "Networking", to: vmTabPath(vm, "networking") },
          { label: "Storage", to: vmTabPath(vm, "storage") },
          { label: "Events", to: vmTabPath(vm, "events") },
          { label: "YAML", to: vmTabPath(vm, "yaml") },
        ]}
      />

      <Outlet />

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
    </Stack>
  );
}
