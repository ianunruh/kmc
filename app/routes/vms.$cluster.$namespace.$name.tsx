import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconEdit,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
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
  canStart,
  canStop,
  canUnpause,
  dataVolumePath,
  formatAge,
  formatDateTime,
  instanceTypePath,
  sizeLabel,
  vmConsolePath,
  vmEditPath,
  vmsListPath,
} from "~/lib/format";
import { hasClusterPrometheus } from "~/lib/k8s/cluster-config.server";
import { listResourceEvents } from "~/lib/k8s/events.server";
import { getCustomObjectYaml } from "~/lib/k8s/yaml.server";
import type { VmLifecycleIntent, VmVolumeInfo } from "~/lib/types";
import {
  deleteVm,
  getVm,
  pauseVm,
  restartVm,
  startVm,
  stopVm,
  unpauseVm,
} from "~/vms/vms.server";
import { VmMetricsPanel } from "~/vms/vm-metrics-panel";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";

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
  return {
    vm,
    events,
    yaml,
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
    if (intent === "pause") {
      await pauseVm(cluster, namespace, name);
      return { ok: true, intent };
    }
    if (intent === "unpause") {
      await unpauseVm(cluster, namespace, name);
      return { ok: true, intent };
    }
    if (intent === "delete") {
      await deleteVm(cluster, namespace, name);
      return redirect("/");
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
  "stop" | "restart" | "pause"
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
    title: "Restart virtual machine",
    confirmLabel: "Restart VM",
    message: "This will reboot the virtual machine.",
  },
  pause: {
    title: "Pause virtual machine",
    confirmLabel: "Pause VM",
    message: "This will pause the virtual machine. It can be unpaused later.",
  },
};

export default function VmDetailPage({ loaderData }: Route.ComponentProps) {
  const { vm, events, yaml, prometheusConfigured } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const { refreshNow } = useRefresh();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmIntent, setConfirmIntent] =
    useState<ConfirmableLifecycleIntent | null>(null);
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
      notifyActionSuccess("Done", `VM ${data.intent ?? "action"} requested`);
      refreshNow();
    }
  });

  function submitIntent(intent: VmLifecycleIntent) {
    fetcher.submit({ intent }, { method: "post" });
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
            to={vmConsolePath(vm)}
            variant="default"
            leftSection={<IconTerminal2 size={16} />}
            disabled={!canOpenConsole(vm)}
            title={
              canOpenConsole(vm)
                ? "Open serial console"
                : "Serial console requires a live VMI (Running)"
            }
          >
            Console
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
          <Button
            variant="default"
            leftSection={<IconRefresh size={16} />}
            disabled={!canRestart(vm) || busy}
            loading={intentBusy("restart")}
            onClick={() => setConfirmIntent("restart")}
          >
            Restart
          </Button>
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
            color="red"
            variant="light"
            leftSection={<IconTrash size={16} />}
            disabled={busy}
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </Button>
        </Group>
      </Group>

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
                  <Code>{vm.allocatedIpv4}</Code>
                ) : undefined
              }
            />
            <Field label="UID" value={vm.uid ? <Code>{vm.uid}</Code> : undefined} />
          </SimpleGrid>
        </DetailCard>

        <DetailCard title="Networks">
          {vm.networks.length === 0 ? (
            <Text size="sm" c="dimmed">
              No networks configured
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
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Attachment</Table.Th>
                    <Table.Th>MAC</Table.Th>
                    <Table.Th>IPs</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {vm.networks.map((net) => (
                    <Table.Tr key={net.name}>
                      <Table.Td>{net.name}</Table.Td>
                      <Table.Td>
                        {net.multusNetworkName
                          ? `multus:${net.multusNetworkName}`
                          : net.pod
                            ? "pod"
                            : "—"}
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
      </SimpleGrid>

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
        warning="Owned disks (DataVolumes) may also be removed."
        loading={busy}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteOpen(false);
          submitIntent("delete");
        }}
      />
    </Stack>
  );
}
