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
} from "@mantine/core";
import { IconRefresh, IconWorldWww } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher, useRouteLoaderData } from "react-router";
import type { loader as detailLoader } from "./routers.$cluster.$namespace.$name";
import {
  DetailField,
  DetailSection,
  ResourceLink,
  ResourceTable,
  StatusBadge,
  Table,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import {
  floatingIpCreatePath,
  formatDateTime,
  vmPath,
  vpcPath,
} from "~/lib/format";
import {
  instanceTypeSelectData,
  preferredInstanceTypeName,
} from "~/instancetypes/options";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";

const LAYOUT_ID = "routes/routers.$cluster.$namespace.$name";

export default function RouterOverviewTab() {
  const {
    router,
    publicNetworks,
    catalog,
    catalogError,
    sshKeys,
    signedIn,
  } = useRouteLoaderData(LAYOUT_ID) as Awaited<ReturnType<typeof detailLoader>>;
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const { refreshNow } = useRefresh();
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
    fetcher.submit(fd, { method: "post", action: ".." });
  }

  return (
    <Stack gap="md">
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
                fetcher.submit(fd, { method: "post", action: ".." });
              }}
            >
              Enable external gateway
            </Button>
          </Stack>
        )}
      </DetailSection>

      <DetailSection
        title={`Floating IPs (${router.floatingIps.length})`}
        actions={
          router.hasExternal ? (
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
          ) : undefined
        }
      >
        {router.floatingIps.length === 0 ? (
          <Text size="sm" c="dimmed">
            {router.hasExternal
              ? "No floating IPs yet. Associate one to map a public address to a VM."
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
    </Stack>
  );
}
