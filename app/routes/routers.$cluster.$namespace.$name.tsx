import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconRefresh,
  IconTrash,
  IconWorldWww,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/routers.$cluster.$namespace.$name";
import {
  ConfirmDeleteModal,
  DetailField,
  DetailSection,
  ResourceIdentity,
  ResourceLink,
  ResourceTable,
  StatusBadge,
  Table,
  YamlPanel,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { getRequestSession } from "~/lib/auth/middleware.server";
import { actionFailure } from "~/lib/errors";
import {
  floatingIpCreatePath,
  formatDateTime,
  routersListPath,
  vmPath,
  vpcPath,
} from "~/lib/format";
import {
  instanceTypeSelectData,
  preferredInstanceTypeName,
} from "~/instancetypes/options";
import { getClusterCatalog } from "~/lib/k8s/catalog.server";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { listSshKeysOrEmpty } from "~/ssh-keys/ssh-keys.server";
import {
  deleteRouter,
  getRouter,
  getRouterYaml,
  recreateRouterVm,
  setRouterExternalGateway,
} from "~/vpcs/routers.server";
import { listPublicEgressNetworks } from "~/vpcs/vpcs.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Router"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const [router, yaml] = await Promise.all([
    getRouter(cluster, namespace, name),
    getRouterYaml(cluster, namespace, name),
  ]);
  const publicNetworks = listPublicEgressNetworks(cluster);
  const session = getRequestSession();
  const { keys: sshKeys } = await listSshKeysOrEmpty(session?.user ?? null);

  let catalog: Awaited<ReturnType<typeof getClusterCatalog>> | null = null;
  let catalogError: string | null = null;
  if (router.vmMissing) {
    try {
      catalog = await getClusterCatalog(cluster);
    } catch (err) {
      catalogError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    router,
    yaml,
    publicNetworks,
    catalog,
    catalogError,
    sshKeys: sshKeys.map((k) => ({
      id: k.id,
      name: k.name,
      publicKey: k.publicKey,
      fingerprint: k.fingerprint,
    })),
    signedIn: Boolean(session?.user),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing path params" };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "delete") {
    try {
      await deleteRouter(cluster, namespace, name);
      return redirect("/routers");
    } catch (err) {
      return actionFailure("router.delete", err, { cluster, namespace, name });
    }
  }
  if (intent === "set-external") {
    try {
      const publicMultusNetwork = String(
        form.get("publicMultusNetwork") ?? "",
      ).trim();
      const sshPublicKey = await resolveSshPublicKey(form);
      await setRouterExternalGateway({
        cluster,
        namespace,
        routerName: name,
        publicMultusNetwork,
        sshPublicKey,
      });
      return { ok: true, intent: "set-external" };
    } catch (err) {
      return actionFailure("router.setExternal", err, {
        cluster,
        namespace,
        name,
      });
    }
  }
  if (intent === "recreate-vm") {
    try {
      const sshPublicKey = await resolveSshPublicKey(form);
      const imageValue = String(form.get("image") ?? "").trim();
      const diskSize = String(form.get("diskSize") ?? "").trim() || "10Gi";
      const storageClass =
        String(form.get("storageClass") ?? "").trim() || undefined;
      const sizeMode = String(form.get("sizeMode") ?? "manual").trim();
      const instanceType =
        String(form.get("instanceType") ?? "").trim() || undefined;
      const cpuCoresRaw = String(form.get("cpuCores") ?? "").trim();
      const memory = String(form.get("memory") ?? "").trim() || undefined;

      if (!imageValue) {
        return { ok: false, error: "Image is required to recreate the appliance" };
      }
      const [imageNamespace, imageName] = imageValue.includes("/")
        ? (imageValue.split("/") as [string, string])
        : ["vm-images", imageValue];

      const base = {
        cluster,
        namespace,
        routerName: name,
        sshPublicKey,
        diskSize,
        storageClass,
        image: {
          kind: "pvc" as const,
          namespace: imageNamespace,
          name: imageName,
        },
      };

      if (sizeMode === "instancetype" && instanceType) {
        await recreateRouterVm({ ...base, instanceType });
      } else {
        const cpuCores = Number(cpuCoresRaw || 1);
        if (!Number.isFinite(cpuCores) || cpuCores < 1) {
          return { ok: false, error: "CPU cores must be a positive number" };
        }
        if (!memory) {
          return { ok: false, error: "Memory is required" };
        }
        await recreateRouterVm({ ...base, cpuCores, memory });
      }
      return { ok: true, intent: "recreate-vm" };
    } catch (err) {
      return actionFailure("router.recreateVm", err, {
        cluster,
        namespace,
        name,
      });
    }
  }
  return { ok: false, error: `Unknown intent: ${intent}` };
}

async function resolveSshPublicKey(form: FormData): Promise<string> {
  let sshPublicKey = String(form.get("sshPublicKey") ?? "").trim();
  const sshKeyMode = String(form.get("sshKeyMode") ?? "paste").trim();
  const savedSshKeyId = String(form.get("savedSshKeyId") ?? "").trim();
  if (sshKeyMode === "saved" && savedSshKeyId) {
    const session = getRequestSession();
    if (!session?.user) {
      throw new Error("Sign in to use a saved SSH key");
    }
    const { keys } = await listSshKeysOrEmpty(session.user);
    const match = keys.find((k) => k.id === savedSshKeyId);
    if (!match) throw new Error("Saved SSH key not found");
    sshPublicKey = match.publicKey;
  }
  if (!sshPublicKey) throw new Error("SSH public key is required");
  return sshPublicKey;
}

export default function RouterDetailPage({ loaderData }: Route.ComponentProps) {
  const {
    router,
    yaml,
    publicNetworks,
    catalog,
    catalogError,
    sshKeys,
    signedIn,
  } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const { refreshNow } = useRefresh();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [publicNet, setPublicNet] = useState(
    publicNetworks[0]?.multusNetwork ?? "",
  );
  const [sshMode, setSshMode] = useState<"saved" | "paste">(
    signedIn && sshKeys.length > 0 ? "saved" : "paste",
  );
  const [savedKeyId, setSavedKeyId] = useState(sshKeys[0]?.id ?? "");
  const [sshPaste, setSshPaste] = useState("");

  const imageOptions = useMemo(() => {
    if (!catalog) return [];
    return catalog.images.map((img) => ({
      value: `${img.namespace}/${img.name}`,
      label: `${img.name}${img.capacity ? ` (${img.capacity})` : ""}`,
    }));
  }, [catalog]);
  const defaultImage =
    imageOptions.find((o) => o.value.includes("ubuntu"))?.value ??
    imageOptions[0]?.value ??
    "";
  const hasInstanceTypes = Boolean(catalog?.hasInstanceTypes);
  const instanceTypeOptions = useMemo(
    () => instanceTypeSelectData(catalog?.instanceTypes ?? []),
    [catalog],
  );
  const defaultInstanceType = preferredInstanceTypeName(
    catalog?.instanceTypes ?? [],
  );

  const [image, setImage] = useState(defaultImage);
  const [diskSize, setDiskSize] = useState("10Gi");
  const [storageClass, setStorageClass] = useState(
    catalog?.defaultStorageClass ?? "",
  );
  const [sizeMode, setSizeMode] = useState<"instancetype" | "manual">(
    hasInstanceTypes && defaultInstanceType ? "instancetype" : "manual",
  );
  const [instanceType, setInstanceType] = useState(defaultInstanceType ?? "");
  const [cpuCores, setCpuCores] = useState(1);
  const [memory, setMemory] = useState("1Gi");

  const busy = fetcher.state !== "idle";
  const recreateDisabled =
    busy ||
    !image ||
    (sshMode === "paste" && !sshPaste.trim()) ||
    (sshMode === "saved" && !savedKeyId) ||
    (sizeMode === "instancetype" && !instanceType) ||
    (sizeMode === "manual" && !memory.trim());

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error);
    } else if (data.ok) {
      notifyActionSuccess(
        "Done",
        data.intent === "set-external"
          ? "External gateway enabled (router VM recreated)"
          : data.intent === "recreate-vm"
            ? "Router appliance VM recreated from policy"
            : "Action completed",
      );
      refreshNow();
    }
  });

  function submitRecreateVm() {
    const fd = new FormData();
    fd.set("intent", "recreate-vm");
    fd.set("image", image);
    fd.set("diskSize", diskSize.trim() || "10Gi");
    if (storageClass) fd.set("storageClass", storageClass);
    fd.set("sizeMode", sizeMode);
    if (sizeMode === "instancetype") {
      fd.set("instanceType", instanceType);
    } else {
      fd.set("cpuCores", String(cpuCores));
      fd.set("memory", memory.trim());
    }
    fd.set("sshKeyMode", sshMode);
    if (sshMode === "saved") fd.set("savedSshKeyId", savedKeyId);
    else fd.set("sshPublicKey", sshPaste.trim());
    fetcher.submit(fd, { method: "post" });
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Button
            component={Link}
            to={routersListPath()}
            variant="subtle"
            size="compact-sm"
            leftSection={<IconArrowLeft size={14} />}
            mb="xs"
          >
            Routers
          </Button>
          <Group gap="sm" mb={4}>
            <Title order={2}>{router.name}</Title>
            {router.agentStatus && <StatusBadge status={router.agentStatus} />}
            {router.hasExternal && (
              <Badge variant="light" color="teal">
                External
              </Badge>
            )}
            {router.vmMissing && (
              <Badge variant="light" color="orange">
                VM missing
              </Badge>
            )}
          </Group>
          <ResourceIdentity
            items={[
              {
                label: router.cluster,
                to: routersListPath({ cluster: router.cluster }),
              },
              {
                label: router.namespace,
                to: routersListPath({
                  cluster: router.cluster,
                  namespace: router.namespace,
                }),
              },
            ]}
          />
        </div>
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

      {router.vmMissing ? (
        <Alert color="orange" variant="light" title="Appliance VM missing">
          The router policy (leases, floating IPs, interfaces) is still here, but the
          VirtualMachine was deleted. Recreate the appliance below — do not create a
          new router with the same name (policy already exists).
        </Alert>
      ) : (
        <Alert color="gray" variant="light">
          Shared router: DHCP + DNS on attached VPCs. With an external gateway, SNAT
          egress and floating IPs are handled by this appliance.
        </Alert>
      )}

      {router.vmMissing && (
        <DetailSection title="Recreate appliance VM">
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Rebuilds the KubeVirt VM from this router&apos;s policy ConfigMap
              (stable MACs, gateway IPs, leases, and floating IPs). Cloud-init is
              regenerated with a new agent token.
            </Text>
            {catalogError && (
              <Alert color="red" variant="light" title="Catalog unavailable">
                {catalogError}
              </Alert>
            )}
            <Select
              label="Image"
              data={imageOptions}
              value={image || null}
              onChange={(v) => setImage(v ?? "")}
              searchable
              required
              disabled={Boolean(catalogError) || imageOptions.length === 0}
            />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label="Disk size"
                value={diskSize}
                onChange={(e) => setDiskSize(e.currentTarget.value)}
                required
              />
              <Select
                label="Storage class"
                data={(catalog?.storageClasses ?? []).map((s) => s.name)}
                value={storageClass || null}
                onChange={(v) => setStorageClass(v ?? "")}
                clearable
                searchable
              />
            </SimpleGrid>
            {hasInstanceTypes ? (
              <Select
                label="Size mode"
                data={[
                  { value: "instancetype", label: "Instance type" },
                  { value: "manual", label: "CPU / memory" },
                ]}
                value={sizeMode}
                onChange={(v) =>
                  setSizeMode(v === "manual" ? "manual" : "instancetype")
                }
              />
            ) : null}
            {sizeMode === "instancetype" && hasInstanceTypes ? (
              <Select
                label="Instance type"
                data={instanceTypeOptions}
                value={instanceType || null}
                onChange={(v) => setInstanceType(v ?? "")}
                searchable
                required
              />
            ) : (
              <SimpleGrid cols={2}>
                <NumberInput
                  label="CPU cores"
                  min={1}
                  value={cpuCores}
                  onChange={(v) => setCpuCores(typeof v === "number" ? v : 1)}
                />
                <TextInput
                  label="Memory"
                  value={memory}
                  onChange={(e) => setMemory(e.currentTarget.value)}
                  required
                />
              </SimpleGrid>
            )}
            {signedIn && sshKeys.length > 0 && (
              <Select
                label="SSH key"
                data={[
                  ...sshKeys.map((k) => ({
                    value: k.id,
                    label: `${k.name} (${k.fingerprint})`,
                  })),
                  { value: "__paste__", label: "Paste a key…" },
                ]}
                value={sshMode === "saved" ? savedKeyId : "__paste__"}
                onChange={(v) => {
                  if (v === "__paste__" || !v) {
                    setSshMode("paste");
                  } else {
                    setSshMode("saved");
                    setSavedKeyId(v);
                  }
                }}
              />
            )}
            {(sshMode === "paste" || !signedIn || sshKeys.length === 0) && (
              <Textarea
                label="SSH public key"
                minRows={2}
                value={sshPaste}
                onChange={(e) => setSshPaste(e.currentTarget.value)}
                required
              />
            )}
            <Button
              leftSection={<IconRefresh size={14} />}
              loading={busy}
              disabled={recreateDisabled}
              onClick={submitRecreateVm}
            >
              Recreate appliance VM
            </Button>
          </Stack>
        </DetailSection>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField label="Age" value={router.age} />
            <DetailField
              label="Policy ConfigMap"
              value={<Code>{router.policyConfigMap}</Code>}
            />
            <DetailField
              label="Appliance VM"
              value={
                router.vmMissing ? (
                  <Text size="sm" c="dimmed">
                    {router.vmName} (missing)
                  </Text>
                ) : (
                  <ResourceLink
                    to={vmPath({
                      cluster: router.cluster,
                      namespace: router.namespace,
                      name: router.vmName,
                    })}
                  >
                    {router.vmName}
                  </ResourceLink>
                )
              }
            />
            <DetailField
              label="VM status"
              value={
                router.vmMissing ? (
                  <Badge size="sm" variant="light" color="orange">
                    Missing
                  </Badge>
                ) : router.vmStatus ? (
                  <StatusBadge status={router.vmStatus} />
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Agent"
              value={
                router.agentStatus ? (
                  <Group gap={6}>
                    <StatusBadge status={router.agentStatus} />
                    {router.agentVersion ? (
                      <Text size="xs" c="dimmed" ff="monospace">
                        {router.agentVersion}
                      </Text>
                    ) : null}
                  </Group>
                ) : (
                  "—"
                )
              }
            />
            <DetailField
              label="Heartbeat"
              value={
                router.agentHeartbeatAt
                  ? formatDateTime(router.agentHeartbeatAt)
                  : "—"
              }
            />
          </SimpleGrid>
          {router.agentLastError ? (
            <Alert color="red" variant="light" mt="sm" title="Agent error">
              <Code block>{router.agentLastError}</Code>
            </Alert>
          ) : null}
        </DetailSection>

        <DetailSection title="Interfaces (VPCs)">
          {router.interfaces.length === 0 ? (
            <Text size="sm" c="dimmed">
              No VPC interfaces.
            </Text>
          ) : (
            <ResourceTable
              isEmpty={false}
              headers={["VPC", "CIDR", "Gateway", "Domain", "Leases"]}
            >
              {router.interfaces.map((iface) => (
                <Table.Tr key={iface.vpc}>
                  <Table.Td>
                    <ResourceLink
                      to={vpcPath({
                        cluster: router.cluster,
                        namespace: router.namespace,
                        name: iface.vpc,
                      })}
                    >
                      {iface.vpc}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <Code>{iface.cidr}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Code>{iface.gateway}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" ff="monospace">
                      {iface.domain ?? "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td>{iface.leaseCount ?? 0}</Table.Td>
                </Table.Tr>
              ))}
            </ResourceTable>
          )}
        </DetailSection>
      </SimpleGrid>

      <DetailSection title="External gateway">
        {router.external ? (
          <Stack gap="sm">
            <SimpleGrid cols={2} spacing="sm">
              <DetailField
                label="Public Multus"
                value={<Code>{router.external.multusNetwork}</Code>}
              />
              <DetailField
                label="Primary public"
                value={
                  router.external.primaryCidr ? (
                    <Code>{router.external.primaryCidr}</Code>
                  ) : (
                    "—"
                  )
                }
              />
              <DetailField
                label="Public gateway"
                value={
                  router.external.gateway ? (
                    <Code>{router.external.gateway}</Code>
                  ) : (
                    "—"
                  )
                }
              />
              <DetailField
                label="SNAT"
                value={router.external.snat === false ? "off" : "on"}
              />
            </SimpleGrid>
            <Group>
              <Button
                component={Link}
                to={floatingIpCreatePath({
                  cluster: router.cluster,
                  namespace: router.namespace,
                  vpc: router.vpcNames[0],
                })}
                size="xs"
                variant="light"
                leftSection={<IconWorldWww size={14} />}
                disabled={router.vpcNames.length === 0 || router.vmMissing}
              >
                Associate floating IP
              </Button>
            </Group>
          </Stack>
        ) : publicNetworks.length === 0 ? (
          <Text size="sm" c="dimmed">
            No public Multus networks with ipPools on this cluster. Add one in{" "}
            <Code>clusters.yaml</Code> to enable external SNAT / floating IPs.
          </Text>
        ) : router.vmMissing ? (
          <Text size="sm" c="dimmed">
            Recreate the appliance VM first, then enable an external gateway.
          </Text>
        ) : (
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Adding an external gateway recreates the router VM with a public Multus
              NIC (brief downtime). SSH key is required for the new cloud-init.
            </Text>
            <Select
              label="Public / egress network"
              data={publicNetworks.map((p) => ({
                value: p.multusNetwork,
                label: `${p.multusNetwork} · ${p.cidr}`,
              }))}
              value={publicNet}
              onChange={(v) => setPublicNet(v ?? "")}
              searchable
            />
            {signedIn && sshKeys.length > 0 && (
              <Select
                label="SSH key"
                data={[
                  ...sshKeys.map((k) => ({
                    value: k.id,
                    label: `${k.name} (${k.fingerprint})`,
                  })),
                  { value: "__paste__", label: "Paste a key…" },
                ]}
                value={sshMode === "saved" ? savedKeyId : "__paste__"}
                onChange={(v) => {
                  if (v === "__paste__" || !v) {
                    setSshMode("paste");
                  } else {
                    setSshMode("saved");
                    setSavedKeyId(v);
                  }
                }}
              />
            )}
            {(sshMode === "paste" || !signedIn || sshKeys.length === 0) && (
              <Textarea
                label="SSH public key"
                minRows={2}
                value={sshPaste}
                onChange={(e) => setSshPaste(e.currentTarget.value)}
              />
            )}
            <Button
              size="xs"
              loading={busy}
              disabled={!publicNet || (sshMode === "paste" && !sshPaste.trim())}
              onClick={() => {
                const fd = new FormData();
                fd.set("intent", "set-external");
                fd.set("publicMultusNetwork", publicNet);
                fd.set("sshKeyMode", sshMode);
                if (sshMode === "saved") fd.set("savedSshKeyId", savedKeyId);
                else fd.set("sshPublicKey", sshPaste.trim());
                fetcher.submit(fd, { method: "post" });
              }}
            >
              Enable external gateway
            </Button>
          </Stack>
        )}
      </DetailSection>

      <DetailSection title={`Floating IPs (${router.floatingIps.length})`}>
        {router.floatingIps.length === 0 ? (
          <Text size="sm" c="dimmed">
            {router.hasExternal
              ? "No floating IPs yet. Associate from Floating IPs → Create."
              : "Enable an external gateway first."}
          </Text>
        ) : (
          <ResourceTable
            isEmpty={false}
            headers={["Public", "Private", "VM", "State"]}
          >
            {router.floatingIps.map((f) => (
              <Table.Tr key={f.id}>
                <Table.Td>
                  <Code>
                    {f.public}/{f.prefix}
                  </Code>
                </Table.Td>
                <Table.Td>
                  {f.private ? <Code>{f.private}</Code> : "—"}
                </Table.Td>
                <Table.Td>
                  {f.targetVm ? (
                    <ResourceLink
                      to={vmPath({
                        cluster: router.cluster,
                        namespace: router.namespace,
                        name: f.targetVm,
                      })}
                    >
                      {f.targetVm}
                    </ResourceLink>
                  ) : (
                    "—"
                  )}
                </Table.Td>
                <Table.Td>
                  <Badge size="sm" variant="light">
                    {f.state}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            ))}
          </ResourceTable>
        )}
      </DetailSection>

      <DetailSection title={`DHCP leases (${router.leases.length})`}>
        {router.leases.length === 0 ? (
          <Text size="sm" c="dimmed">
            No leases yet. Launch a VM attached to a VPC on this router to register a
            static lease (guest uses DHCP).
          </Text>
        ) : (
          <ResourceTable
            isEmpty={false}
            headers={["Hostname", "VPC", "IP", "MAC", "VM"]}
          >
            {router.leases.map((L) => (
              <Table.Tr key={`${L.vpc}/${L.mac}/${L.ip}`}>
                <Table.Td>
                  <Text size="sm" ff="monospace">
                    {L.hostname}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <ResourceLink
                    to={vpcPath({
                      cluster: router.cluster,
                      namespace: router.namespace,
                      name: L.vpc,
                    })}
                  >
                    {L.vpc}
                  </ResourceLink>
                </Table.Td>
                <Table.Td>
                  <Code>{L.ip}</Code>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" ff="monospace" c="dimmed">
                    {L.mac}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {L.vm ? (
                    <ResourceLink
                      to={vmPath({
                        cluster: router.cluster,
                        namespace: router.namespace,
                        name: L.vm,
                      })}
                    >
                      {L.vm}
                    </ResourceLink>
                  ) : (
                    "—"
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </ResourceTable>
        )}
      </DetailSection>

      <YamlPanel yaml={yaml} />

      <ConfirmDeleteModal
        opened={deleteOpen}
        resourceName={router.name}
        identity={`${router.cluster}/${router.namespace}/${router.name}`}
        title="Delete router"
        confirmLabel="Delete router"
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit({ intent: "delete" }, { method: "post" });
          setDeleteOpen(false);
        }}
      />
    </Stack>
  );
}
