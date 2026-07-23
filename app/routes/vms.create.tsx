import {
  Alert,
  Button,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import { Link, redirect, useFetcher, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/vms.create";
import { notifyActionError } from "~/lib/action-feedback";
import { getRequestSession } from "~/lib/auth/middleware.server";
import { logServerError } from "~/lib/errors";
import { vmPath } from "~/lib/format";
import { getImagePreference } from "~/lib/k8s/catalog.server";
import { listSshKeysOrEmpty } from "~/ssh-keys/ssh-keys.server";
import { FormActions, FormSection } from "~/ui";
import { createVm, listClusters } from "~/vms/vms.server";
import type { ClusterCatalog, CreateVmRequest, NetworkInfo } from "~/lib/types";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Launch VM · kmc" }];
}

export async function loader() {
  const clusters = await listClusters();
  const session = getRequestSession();
  const { keys: sshKeys, error: sshKeysError } = await listSshKeysOrEmpty(
    session?.user ?? null,
  );
  return {
    clusters,
    sshKeys: sshKeys.map((k) => ({
      id: k.id,
      name: k.name,
      publicKey: k.publicKey,
      fingerprint: k.fingerprint,
    })),
    sshKeysError: sshKeysError ?? null,
    signedIn: Boolean(session?.user),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();

  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const sizeMode = String(form.get("sizeMode") ?? "manual");
  const instanceType = String(form.get("instanceType") ?? "").trim() || undefined;
  const cpuCoresRaw = String(form.get("cpuCores") ?? "").trim();
  const memory = String(form.get("memory") ?? "").trim() || undefined;
  const diskSize = String(form.get("diskSize") ?? "").trim();
  const storageClass = String(form.get("storageClass") ?? "").trim() || undefined;
  const imageValue = String(form.get("image") ?? "").trim();
  const network = String(form.get("network") ?? "").trim() || undefined;
  const sshKeyMode = String(form.get("sshKeyMode") ?? "paste").trim();
  const savedSshKeyId = String(form.get("savedSshKeyId") ?? "").trim();
  let sshPublicKey = String(form.get("sshPublicKey") ?? "").trim();
  const start = form.get("start") !== "false";

  if (!cluster) return { error: "Cluster is required" };
  if (!namespace) return { error: "Namespace is required" };
  if (!name) return { error: "Name is required" };
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
    return {
      error: "Name must be a DNS-1123 label (lowercase alphanumeric and hyphens)",
    };
  }
  if (!diskSize) return { error: "Disk size is required" };
  if (!imageValue) return { error: "Image is required" };

  if (sshKeyMode === "saved") {
    if (!savedSshKeyId) return { error: "Select an SSH key" };
    const session = getRequestSession();
    if (!session?.user) {
      return { error: "Sign in to use a saved SSH key, or paste a key instead" };
    }
    const { keys, error: listErr } = await listSshKeysOrEmpty(session.user);
    if (listErr) return { error: `Could not load SSH keys: ${listErr}` };
    const match = keys.find((k) => k.id === savedSshKeyId);
    if (!match) return { error: "Selected SSH key was not found — pick another or paste" };
    sshPublicKey = match.publicKey;
  }

  if (!sshPublicKey) return { error: "SSH public key is required" };

  const [imageNamespace, imageName] = imageValue.includes("/")
    ? (imageValue.split("/") as [string, string])
    : ["vm-images", imageValue];

  // Preference comes from the golden image PVC label, not a form field.
  const preference = await getImagePreference(cluster, imageNamespace, imageName);

  const payload: CreateVmRequest = {
    cluster,
    namespace,
    name,
    diskSize,
    storageClass,
    image: { kind: "pvc", namespace: imageNamespace, name: imageName },
    sshPublicKey,
    start,
    preference,
  };

  if (sizeMode === "instancetype" && instanceType) {
    payload.instanceType = instanceType;
  } else {
    const cpuCores = Number(cpuCoresRaw || 1);
    if (!Number.isFinite(cpuCores) || cpuCores < 1) {
      return { error: "CPU cores must be a positive number" };
    }
    if (!memory) return { error: "Memory is required" };
    payload.cpuCores = cpuCores;
    payload.memory = memory;
  }

  if (network) {
    payload.network = { multusNetworkName: network };
  }

  try {
    await createVm(payload);
    return redirect(
      vmPath({
        cluster: payload.cluster,
        namespace: payload.namespace,
        name: payload.name,
      }),
    );
  } catch (err) {
    return {
      error: logServerError("vm.create", err, {
        cluster: payload.cluster,
        namespace: payload.namespace,
        name: payload.name,
      }),
    };
  }
}

type CatalogFetcherData = ClusterCatalog;
type NetworksFetcherData = { networks: NetworkInfo[] };

export default function CreateVmPage({ loaderData, actionData }: Route.ComponentProps) {
  const { clusters, sshKeys, sshKeysError, signedIn } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";
  const catalogFetcher = useFetcher<CatalogFetcherData>();
  const networksFetcher = useFetcher<NetworksFetcherData>();
  const hasSavedKeys = sshKeys.length > 0;
  const reachableClusters = clusters.filter((c) => c.reachable);
  const defaultCluster = reachableClusters[0]?.id ?? "";

  const form = useForm({
    initialValues: {
      cluster: defaultCluster,
      namespace: "",
      name: "",
      sizeMode: "manual" as "manual" | "instancetype",
      instanceType: "",
      cpuCores: 2,
      memory: "4Gi",
      diskSize: "100Gi",
      storageClass: "",
      image: "",
      network: "",
      sshKeyMode: (hasSavedKeys ? "saved" : "paste") as "saved" | "paste",
      savedSshKeyId: hasSavedKeys ? sshKeys[0]!.id : "",
      sshPublicKey: "",
      start: true,
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      namespace: (v) => (!v ? "Required" : null),
      name: (v) => {
        if (!v) return "Required";
        if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v)) {
          return "DNS-1123 label required";
        }
        return null;
      },
      diskSize: (v) => (!v ? "Required" : null),
      image: (v) => (!v ? "Required" : null),
      savedSshKeyId: (v, values) =>
        values.sshKeyMode === "saved" && !v ? "Select a key" : null,
      sshPublicKey: (v, values) =>
        values.sshKeyMode === "paste" && !v ? "Required" : null,
    },
  });

  const onSubmit = form.onSubmit((values) => {
    const data: Record<string, string> = {
      cluster: values.cluster,
      namespace: values.namespace,
      name: values.name,
      sizeMode: values.sizeMode,
      instanceType: values.instanceType,
      cpuCores: String(values.cpuCores),
      memory: values.memory,
      diskSize: values.diskSize,
      storageClass: values.storageClass,
      image: values.image,
      network: values.network,
      sshKeyMode: values.sshKeyMode,
      savedSshKeyId: values.savedSshKeyId,
      sshPublicKey: values.sshPublicKey,
      start: values.start ? "true" : "false",
    };
    submit(data, { method: "post" });
  });

  const catalog = catalogFetcher.data;

  useEffect(() => {
    if (!form.values.cluster) return;
    catalogFetcher.load(`/api/catalog/${form.values.cluster}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.cluster]);

  useEffect(() => {
    if (!form.values.cluster || !form.values.namespace) {
      return;
    }
    networksFetcher.load(
      `/api/networks/${form.values.cluster}?namespace=${encodeURIComponent(form.values.namespace)}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.cluster, form.values.namespace]);

  useEffect(() => {
    if (!catalog) return;
    const namespaceNames = catalog.namespaces.map((n) => n.name);
    if (!form.values.namespace || !namespaceNames.includes(form.values.namespace)) {
      form.setFieldValue("namespace", namespaceNames[0] ?? "");
    }
    if (catalog.hasInstanceTypes) {
      form.setFieldValue("sizeMode", "instancetype");
      if (!form.values.instanceType && catalog.instanceTypes[0]) {
        form.setFieldValue("instanceType", catalog.instanceTypes[0].name);
      }
    } else {
      form.setFieldValue("sizeMode", "manual");
    }
    if (!form.values.storageClass && catalog.defaultStorageClass) {
      form.setFieldValue("storageClass", catalog.defaultStorageClass);
    }
    if (!form.values.image && catalog.images[0]) {
      form.setFieldValue(
        "image",
        `${catalog.images[0].namespace}/${catalog.images[0].name}`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  useEffect(() => {
    const networks = networksFetcher.data?.networks ?? [];
    const bridge = networks.find((n) => n.name === "bridge-external");
    if (bridge) {
      form.setFieldValue("network", bridge.name);
    } else if (networks[0]) {
      form.setFieldValue("network", networks[0].name);
    } else {
      form.setFieldValue("network", "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [networksFetcher.data]);

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Launch failed", actionData.error);
    }
  }, [actionData]);

  const namespaceOptions = useMemo(
    () => (catalog?.namespaces ?? []).map((n) => n.name),
    [catalog],
  );
  const imageOptions = useMemo(
    () =>
      (catalog?.images ?? []).map((img) => {
        const bits = [img.name];
        if (img.capacity) bits.push(img.capacity);
        if (img.preference) bits.push(`pref: ${img.preference}`);
        return {
          value: `${img.namespace}/${img.name}`,
          label: bits.length > 1 ? `${bits[0]} (${bits.slice(1).join(" · ")})` : bits[0]!,
        };
      }),
    [catalog],
  );
  const selectedImage = useMemo(() => {
    if (!catalog || !form.values.image) return undefined;
    return catalog.images.find(
      (img) => `${img.namespace}/${img.name}` === form.values.image,
    );
  }, [catalog, form.values.image]);
  const storageOptions = useMemo(
    () =>
      (catalog?.storageClasses ?? []).map((sc) => ({
        value: sc.name,
        label: sc.isDefault ? `${sc.name} (default)` : sc.name,
      })),
    [catalog],
  );
  const instanceTypeOptions = useMemo(
    () =>
      (catalog?.instanceTypes ?? []).map((it) => ({
        value: it.name,
        label:
          it.cpu || it.memory
            ? `${it.name} · ${it.cpu ?? "?"}c / ${it.memory ?? "?"}`
            : it.name,
      })),
    [catalog],
  );
  const networkOptions = useMemo(() => {
    const nets = networksFetcher.data?.networks ?? [];
    return [
      { value: "", label: "Pod network" },
      ...nets.map((n) => {
        const vlanPart = n.vlan != null ? `vlan ${n.vlan}` : null;
        const kindPart = n.kind === "vpc" ? "VPC" : null;
        if (n.ipPool) {
          const { cidr, free, total } = n.ipPool;
          const bits = [
            n.name,
            kindPart,
            vlanPart,
            `IPAM ${free}/${total} free · ${cidr}`,
          ].filter(Boolean);
          return { value: n.name, label: bits.join(" · ") };
        }
        const bits = [n.name, kindPart, vlanPart].filter(Boolean);
        return { value: n.name, label: bits.join(" · ") };
      }),
    ];
  }, [networksFetcher.data]);

  const selectedNetworkPool = useMemo(() => {
    const nets = networksFetcher.data?.networks ?? [];
    return nets.find((n) => n.name === form.values.network)?.ipPool;
  }, [networksFetcher.data, form.values.network]);

  return (
    <Stack gap="md" pb={80}>
      <div>
        <Title order={2} size="h3">
          Launch virtual machine
        </Title>
        <Text size="sm" c="dimmed">
          Provision a KubeVirt VM by cloning a golden image PVC
        </Text>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Launch failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Placement">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <Select
                label="Cluster"
                placeholder="Select cluster"
                data={reachableClusters.map((c) => c.id)}
                required
                value={form.values.cluster}
                error={form.errors.cluster}
                onChange={(v) => {
                  form.setFieldValue("cluster", v ?? "");
                  form.setFieldValue("namespace", "");
                  form.setFieldValue("image", "");
                  form.setFieldValue("storageClass", "");
                  form.setFieldValue("instanceType", "");
                  form.setFieldValue("network", "");
                }}
              />
              <Select
                label="Namespace"
                placeholder="Select namespace"
                data={namespaceOptions}
                required
                disabled={!form.values.cluster || catalogFetcher.state === "loading"}
                searchable
                nothingFoundMessage="No namespaces labeled kmc.ianunruh.com/vm-allowed=true"
                value={form.values.namespace || null}
                error={form.errors.namespace}
                onChange={(v) => form.setFieldValue("namespace", v ?? "")}
              />
            </SimpleGrid>
            <TextInput
              label="Name"
              placeholder="my-vm"
              required
              autoFocus
              {...form.getInputProps("name")}
            />
          </FormSection>

          <FormSection title="Size & disk">
            {catalog?.hasInstanceTypes && (
              <Select
                label="Instance type"
                data={instanceTypeOptions}
                value={form.values.instanceType || null}
                onChange={(v) => {
                  form.setFieldValue("instanceType", v ?? "");
                  form.setFieldValue("sizeMode", v ? "instancetype" : "manual");
                }}
              />
            )}
            {(!catalog?.hasInstanceTypes || form.values.sizeMode === "manual") && (
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                <NumberInput
                  label="CPU cores"
                  min={1}
                  max={64}
                  {...form.getInputProps("cpuCores")}
                />
                <TextInput
                  label="Memory"
                  placeholder="4Gi"
                  {...form.getInputProps("memory")}
                />
              </SimpleGrid>
            )}
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <TextInput
                label="Disk size"
                placeholder="100Gi"
                required
                {...form.getInputProps("diskSize")}
              />
              <Select
                label="Storage class"
                data={storageOptions}
                clearable
                value={form.values.storageClass || null}
                onChange={(v) => form.setFieldValue("storageClass", v ?? "")}
              />
            </SimpleGrid>
            <Select
              label="Image"
              placeholder="Select golden image PVC"
              description={
                selectedImage?.preference
                  ? `Applies cluster preference “${selectedImage.preference}”`
                  : selectedImage
                    ? "No cluster preference labeled on this image"
                    : undefined
              }
              data={imageOptions}
              required
              disabled={!catalog}
              value={form.values.image || null}
              error={form.errors.image}
              onChange={(v) => form.setFieldValue("image", v ?? "")}
            />
          </FormSection>

          <FormSection title="Access & network">
            {sshKeysError ? (
              <Alert color="yellow" title="Saved SSH keys unavailable">
                {sshKeysError}. You can still paste a one-off public key below.
              </Alert>
            ) : null}
            {hasSavedKeys ? (
              <Select
                label="SSH key source"
                data={[
                  { value: "saved", label: "Saved key" },
                  { value: "paste", label: "Paste a one-off key" },
                ]}
                value={form.values.sshKeyMode}
                onChange={(v) =>
                  form.setFieldValue(
                    "sshKeyMode",
                    v === "paste" ? "paste" : "saved",
                  )
                }
              />
            ) : null}
            {form.values.sshKeyMode === "saved" && hasSavedKeys ? (
              <Stack gap={4}>
                <Select
                  label="SSH public key"
                  description="Managed under SSH Keys in the sidebar"
                  data={sshKeys.map((k) => ({
                    value: k.id,
                    label: `${k.name} · ${k.fingerprint}`,
                  }))}
                  required
                  value={form.values.savedSshKeyId || null}
                  error={form.errors.savedSshKeyId}
                  onChange={(v) => form.setFieldValue("savedSshKeyId", v ?? "")}
                />
                <Text size="xs" c="dimmed">
                  <Text span component={Link} to="/ssh-keys" c="accent.4">
                    Manage saved keys
                  </Text>
                </Text>
              </Stack>
            ) : (
              <Stack gap={4}>
                <Textarea
                  label="SSH public key"
                  placeholder="ssh-ed25519 AAAA… user@host"
                  minRows={3}
                  required
                  autosize
                  {...form.getInputProps("sshPublicKey")}
                />
                {signedIn && !hasSavedKeys && !sshKeysError ? (
                  <Text size="xs" c="dimmed">
                    Save keys on the{" "}
                    <Text span component={Link} to="/ssh-keys" c="accent.4">
                      SSH Keys
                    </Text>{" "}
                    page to select them here next time.
                  </Text>
                ) : null}
              </Stack>
            )}
            <Select
              label="Network"
              description="Multus NAD in the target namespace, or pod network"
              data={networkOptions}
              value={form.values.network}
              onChange={(v) => form.setFieldValue("network", v ?? "")}
            />
            {selectedNetworkPool ? (
              <Text size="xs" c="dimmed">
                Auto-assigns a free address from pool{" "}
                <Text span ff="monospace" c="gray.4">
                  {selectedNetworkPool.id}
                </Text>{" "}
                ({selectedNetworkPool.cidr}
                {selectedNetworkPool.gateway
                  ? `, gateway ${selectedNetworkPool.gateway}`
                  : ", no default route"}
                ). Configured via cloud-init netplan; released when the VM is
                deleted.
              </Text>
            ) : form.values.network ? (
              <Text size="xs" c="dimmed">
                No IP pool configured for this Multus network — guest networking
                is left unconfigured by kmc.
              </Text>
            ) : null}
          </FormSection>

          <FormActions>
            <Switch
              label="Start after launch"
              checked={form.values.start}
              onChange={(e) => form.setFieldValue("start", e.currentTarget.checked)}
              mr={{ base: 0, sm: "auto" }}
              w={{ base: "100%", sm: "auto" }}
            />
            <Group gap="sm" justify="flex-end" w={{ base: "100%", sm: "auto" }} wrap="nowrap">
              <Button component={Link} to="/" variant="default">
                Cancel
              </Button>
              <Button type="submit" loading={submitting}>
                Launch VM
              </Button>
            </Group>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
