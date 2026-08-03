import {
  Alert,
  Badge,
  Button,
  Checkbox,
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
import {
  IconArrowsRightLeft,
  IconLink,
  IconRefresh,
  IconUnlink,
  IconWorldWww,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher, useRouteLoaderData } from "react-router";
import type { loader as detailLoader } from "./routers.$cluster.$namespace.$name";
import {
  ConditionsSection,
  ConfirmActionModal,
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
  floatingIpDetailPath,
  formatDateTime,
  portForwardCreatePath,
  portForwardDetailPath,
  routerPath,
  vmPath,
  vpcPath,
} from "~/lib/format";
import {
  instanceTypeSelectData,
  preferredInstanceTypeName,
} from "~/instancetypes/options";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { KMC_MAX_MULTUS_ATTACHMENTS } from "~/lib/k8s/constants";

const LAYOUT_ID = "routes/routers.$cluster.$namespace.$name";

export default function RouterOverviewTab() {
  const {
    router,
    publicNetworks,
    attachableVpcs,
    catalog,
    catalogError,
    sshKeys,
    signedIn,
  } = useRouteLoaderData(LAYOUT_ID) as Awaited<ReturnType<typeof detailLoader>>;
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string;
    intent?: string;
    restarted?: boolean;
  }>();
  const { refreshNow } = useRefresh();
  const [publicNet, setPublicNet] = useState(publicNetworks[0]?.multusNetwork ?? "");
  const [sshMode, setSshMode] = useState<"saved" | "paste">(
    signedIn && sshKeys.length > 0 ? "saved" : "paste",
  );
  const [savedKeyId, setSavedKeyId] = useState(sshKeys[0]?.id ?? "");
  const [sshPaste, setSshPaste] = useState("");
  const [attachVpc, setAttachVpc] = useState("");
  const [detachTarget, setDetachTarget] = useState<{
    vpc: string;
    leaseCount: number;
  } | null>(null);
  const [detachForce, setDetachForce] = useState(false);
  const [recreateConfirmOpen, setRecreateConfirmOpen] = useState(false);

  const imageOptions = useMemo(() => {
    if (!catalog) return [];
    return catalog.images.map((img) => ({
      value: `${img.namespace}/${img.name}`,
      label: `${img.name}${img.capacity ? ` (${img.capacity})` : ""}`,
    }));
  }, [catalog]);
  const applianceImage = router.appliance
    ? `${router.appliance.imageNamespace}/${router.appliance.imageName}`
    : "";
  const defaultImage =
    (applianceImage &&
      imageOptions.some((o) => o.value === applianceImage) &&
      applianceImage) ||
    imageOptions.find((o) => o.value.includes("ubuntu"))?.value ||
    imageOptions[0]?.value ||
    applianceImage ||
    "";
  const hasInstanceTypes = Boolean(catalog?.hasInstanceTypes);
  const instanceTypeOptions = useMemo(
    () => instanceTypeSelectData(catalog?.instanceTypes ?? []),
    [catalog],
  );
  const defaultInstanceType =
    router.appliance?.instanceType ||
    preferredInstanceTypeName(catalog?.instanceTypes ?? []);

  const [image, setImage] = useState(defaultImage);
  const [diskSize, setDiskSize] = useState(
    router.appliance?.diskSize?.trim() || "10Gi",
  );
  const [storageClass, setStorageClass] = useState(
    router.appliance?.storageClass ?? catalog?.defaultStorageClass ?? "",
  );
  const [sizeMode, setSizeMode] = useState<"instancetype" | "manual">(() => {
    if (router.appliance) {
      return router.appliance.instanceType ? "instancetype" : "manual";
    }
    return hasInstanceTypes && defaultInstanceType ? "instancetype" : "manual";
  });
  const [instanceType, setInstanceType] = useState(defaultInstanceType ?? "");
  const [cpuCores, setCpuCores] = useState(router.appliance?.cpuCores ?? 1);
  const [memory, setMemory] = useState(router.appliance?.memory ?? "1Gi");

  const busy = fetcher.state !== "idle";
  const recreateDisabled =
    busy ||
    !image ||
    (sshMode === "paste" && !sshPaste.trim()) ||
    (sshMode === "saved" && !savedKeyId) ||
    (sizeMode === "instancetype" && !instanceType) ||
    (sizeMode === "manual" && !memory.trim());

  const freeAttachable = useMemo(
    () =>
      (attachableVpcs ?? []).filter(
        (v) => v.cidr && !v.attachedRouter && !router.vpcNames.includes(v.name),
      ),
    [attachableVpcs, router.vpcNames],
  );

  const multusBudget = router.interfaces.length + (router.hasExternal ? 1 : 0);
  const attachDisabled =
    busy || router.vmMissing || !attachVpc || multusBudget >= KMC_MAX_MULTUS_ATTACHMENTS;

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error);
    } else if (data.ok) {
      notifyActionSuccess(
        "Done",
        data.intent === "set-external"
          ? "External gateway enabled (router VM recreated)"
          : data.intent === "recreate-vm"
            ? "Appliance rebuild requested — wait for the new VM to become Ready"
            : data.intent === "attach-vpc"
              ? data.restarted
                ? "VPC attached — router restarted so the Multus NIC could land"
                : "VPC attached"
              : data.intent === "detach-vpc"
                ? data.restarted
                  ? "VPC detached — router restarted to drop the Multus NIC"
                  : "VPC detached"
                : "Action completed",
      );
      setDetachTarget(null);
      setDetachForce(false);
      setRecreateConfirmOpen(false);
      setAttachVpc("");
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
    // Layout action shares this URL; ".." skips the layout, "." uses ?index (405).
    fetcher.submit(fd, { method: "post", action: routerPath(router) });
    setRecreateConfirmOpen(false);
  }

  function requestRecreateVm() {
    // Existing appliance: confirm destructive delete of VM + root disk.
    if (!router.vmMissing) {
      setRecreateConfirmOpen(true);
      return;
    }
    submitRecreateVm();
  }

  return (
    <Stack gap="md">
      {router.vmRestartRequired && !router.vmMissing && (
        <Alert
          color="yellow"
          variant="light"
          title="Appliance restart required"
        >
          <Stack gap="sm">
            <Text size="sm">
              {router.vmRestartRequiredMessage?.trim() ||
                "KubeVirt staged a change (for example a Multus NIC) that is not live until the appliance VM restarts. DHCP/agent on existing interfaces keep running until then."}
            </Text>
            <Group>
              <Button
                size="xs"
                color="yellow"
                leftSection={<IconRefresh size={14} />}
                loading={busy}
                onClick={() => {
                  const fd = new FormData();
                  fd.set("intent", "restart-vm");
                  fetcher.submit(fd, {
                    method: "post",
                    action: routerPath(router),
                  });
                }}
              >
                Restart appliance
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      <DetailSection
        title={
          router.vmMissing ? "Recreate appliance VM" : "Rebuild appliance VM"
        }
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {router.vmMissing
              ? "Rebuilds the KubeVirt VM from this router&apos;s policy (stable MACs, gateway IPs, leases, and floating IPs). Cloud-init is regenerated with a new agent token and SSH keys (including the platform console key for browser Terminal)."
              : "Deletes the appliance VirtualMachine and root disk, then the controller rebuilds them from this Router CR. Gateway IPs, Multus MACs, policy, floating IPs, and guest leases stay. Use this to rotate SSH keys, change image/size, or fix browser Terminal auth. Brief DHCP/SNAT downtime while the new clone boots."}
          </Text>
          {!router.vmMissing && (
            <Alert color="orange" variant="light" title="Destructive rebuild">
              Root disk state is discarded. Guest VMs on attached VPCs keep their disks;
              they only lose the router until the new appliance is Ready.
            </Alert>
          )}
          {catalogError && (
            <Alert color="red" variant="light" title="Catalog unavailable">
              {catalogError}
            </Alert>
          )}
          <Select
            label="Image"
            data={
              imageOptions.length > 0
                ? imageOptions
                : applianceImage
                  ? [{ value: applianceImage, label: applianceImage }]
                  : []
            }
            value={image || null}
            onChange={(v) => setImage(v ?? "")}
            searchable
            required
            disabled={Boolean(catalogError) && imageOptions.length === 0}
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
              onChange={(v) => setSizeMode(v === "manual" ? "manual" : "instancetype")}
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
              description="Your key, plus the platform console key for browser Terminal"
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
            color={router.vmMissing ? undefined : "orange"}
            onClick={requestRecreateVm}
          >
            {router.vmMissing ? "Recreate appliance VM" : "Rebuild appliance VM"}
          </Button>
        </Stack>
      </DetailSection>

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
                  <Group gap={6} wrap="wrap">
                    <StatusBadge status={router.vmStatus} />
                    {router.vmRestartRequired && (
                      <Badge size="sm" variant="light" color="yellow">
                        Restart required
                      </Badge>
                    )}
                  </Group>
                ) : router.vmRestartRequired ? (
                  <Badge size="sm" variant="light" color="yellow">
                    Restart required
                  </Badge>
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
                router.agentHeartbeatAt ? formatDateTime(router.agentHeartbeatAt) : "—"
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
              headers={["VPC", "CIDR", "Gateway", "Domain", "Leases", ""]}
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
                  <Table.Td>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      leftSection={<IconUnlink size={12} />}
                      disabled={busy || router.interfaces.length <= 1 || router.vmMissing}
                      onClick={() =>
                        setDetachTarget({
                          vpc: iface.vpc,
                          leaseCount: iface.leaseCount ?? 0,
                        })
                      }
                    >
                      Detach
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </ResourceTable>
          )}
          {!router.vmMissing && (
            <Stack gap="xs" mt="sm">
              <Group align="flex-end" gap="sm" wrap="wrap">
                <Select
                  label="Attach VPC"
                  placeholder={
                    freeAttachable.length === 0 ? "No free VPCs" : "Select VPC"
                  }
                  data={freeAttachable.map((v) => ({
                    value: v.name,
                    label: `${v.name} · ${v.cidr}`,
                  }))}
                  value={attachVpc || null}
                  onChange={(v) => setAttachVpc(v ?? "")}
                  searchable
                  clearable
                  disabled={busy || freeAttachable.length === 0}
                  style={{ minWidth: 220, flex: 1 }}
                />
                <Button
                  size="xs"
                  leftSection={<IconLink size={14} />}
                  loading={busy && fetcher.formData?.get("intent") === "attach-vpc"}
                  disabled={attachDisabled}
                  onClick={() => {
                    const fd = new FormData();
                    fd.set("intent", "attach-vpc");
                    fd.set("vpcName", attachVpc);
                    fetcher.submit(fd, {
                      method: "post",
                      action: routerPath(router),
                    });
                  }}
                >
                  Attach VPC
                </Button>
              </Group>
              {multusBudget >= KMC_MAX_MULTUS_ATTACHMENTS && (
                <Text size="xs" c="orange">
                  Multus NIC budget full ({KMC_MAX_MULTUS_ATTACHMENTS}).
                </Text>
              )}
            </Stack>
          )}
        </DetailSection>
      </SimpleGrid>

      <ConfirmActionModal
        opened={Boolean(detachTarget)}
        onClose={() => {
          setDetachTarget(null);
          setDetachForce(false);
        }}
        title={detachTarget ? `Detach VPC ${detachTarget.vpc}` : "Detach VPC"}
        confirmLabel="Detach"
        confirmColor="red"
        loading={busy}
        message={
          <Stack gap="sm">
            <Text size="sm">
              Detach removes this VPC from the router via Multus hot-unplug (no full VM
              recreate). Guests on other VPCs stay up.
            </Text>
            {detachTarget && detachTarget.leaseCount > 0 && (
              <Alert color="orange" variant="light" title="Active leases">
                This VPC has {detachTarget.leaseCount} DHCP lease(s). Detach is refused
                unless you force — guests will lose gateway/DHCP.
              </Alert>
            )}
            <Checkbox
              label="Force detach (drop leases/port forwards; hold floating IPs)"
              checked={detachForce}
              onChange={(e) => setDetachForce(e.currentTarget.checked)}
            />
          </Stack>
        }
        onConfirm={() => {
          if (!detachTarget) return;
          const fd = new FormData();
          fd.set("intent", "detach-vpc");
          fd.set("vpcName", detachTarget.vpc);
          if (detachForce) fd.set("force", "true");
          fetcher.submit(fd, {
            method: "post",
            action: routerPath(router),
          });
        }}
      />

      <ConfirmActionModal
        opened={recreateConfirmOpen}
        onClose={() => setRecreateConfirmOpen(false)}
        title="Rebuild appliance VM"
        confirmLabel="Delete disk and rebuild"
        confirmColor="orange"
        loading={busy}
        message={
          <Stack gap="sm">
            <Text size="sm">
              This deletes VirtualMachine <Code>{router.vmName}</Code> and DataVolume{" "}
              <Code>{router.vmName}-root</Code>, then the controller clones a fresh image
              and re-runs cloud-init (new SSH keys + agent token).
            </Text>
            <Text size="sm">
              DHCP, DNS, and SNAT on this router will be down until the new appliance is
              Ready. Policy, gateway IPs, and Multus MACs are preserved.
            </Text>
          </Stack>
        }
        onConfirm={submitRecreateVm}
      />

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
                  router.external.gateway ? <Code>{router.external.gateway}</Code> : "—"
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
            No public Multus networks with an <Code>IPPool</Code> CR on this
            cluster. Apply an IPPool (see{" "}
            <Code>deploy/controller/examples/ippool.yaml</Code>) to enable
            external SNAT / floating IPs / port forwards.
          </Text>
        ) : router.vmMissing ? (
          <Text size="sm" c="dimmed">
            Recreate the appliance VM first, then enable an external gateway.
          </Text>
        ) : (
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Adding an external gateway recreates the router VM with a public Multus NIC
              (brief downtime). SSH key is required for the new cloud-init.
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
                fetcher.submit(fd, {
                  method: "post",
                  action: routerPath(router),
                });
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
                ...(router.vpcNames.length === 1 ? { vpc: router.vpcNames[0] } : {}),
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
          <ResourceTable isEmpty={false} headers={["Public", "Private", "VM", "State"]}>
            {router.floatingIps.map((f) => (
              <Table.Tr key={f.id}>
                <Table.Td>
                  <ResourceLink
                    to={floatingIpDetailPath({
                      cluster: router.cluster,
                      namespace: router.namespace,
                      id: f.id,
                      public: f.public,
                    })}
                  >
                    <Code>
                      {f.public}/{f.prefix}
                    </Code>
                  </ResourceLink>
                </Table.Td>
                <Table.Td>{f.private ? <Code>{f.private}</Code> : "—"}</Table.Td>
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

      <DetailSection
        title={`Port Forwards (${router.portForwards.length})`}
        actions={
          router.hasExternal ? (
            <Button
              component={Link}
              to={portForwardCreatePath({
                cluster: router.cluster,
                namespace: router.namespace,
                ...(router.vpcNames.length === 1 ? { vpc: router.vpcNames[0] } : {}),
              })}
              size="xs"
              variant="light"
              leftSection={<IconArrowsRightLeft size={14} />}
              disabled={router.vpcNames.length === 0 || router.vmMissing}
            >
              Create port forward
            </Button>
          ) : undefined
        }
      >
        {router.portForwards.length === 0 ? (
          <Text size="sm" c="dimmed">
            {router.hasExternal
              ? "No port forwards yet. Map a public port to a VM without a full floating IP."
              : "Enable an external gateway first."}
          </Text>
        ) : (
          <ResourceTable
            isEmpty={false}
            headers={["Public", "Protocol", "Private", "VM"]}
          >
            {router.portForwards.map((pf) => (
              <Table.Tr key={pf.id}>
                <Table.Td>
                  <ResourceLink
                    to={portForwardDetailPath({
                      cluster: router.cluster,
                      namespace: router.namespace,
                      id: pf.id,
                    })}
                  >
                    <Code>
                      {pf.public}:{pf.publicPort}
                    </Code>
                  </ResourceLink>
                </Table.Td>
                <Table.Td>
                  <Badge size="sm" variant="light" color="blue">
                    {pf.protocol.toUpperCase()}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Code>
                    {pf.private}:{pf.privatePort}
                  </Code>
                </Table.Td>
                <Table.Td>
                  {pf.targetVm ? (
                    <ResourceLink
                      to={vmPath({
                        cluster: router.cluster,
                        namespace: router.namespace,
                        name: pf.targetVm,
                      })}
                    >
                      {pf.targetVm}
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

      <ConditionsSection conditions={router.conditions} />
    </Stack>
  );
}
