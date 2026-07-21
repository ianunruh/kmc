import {
  Alert,
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
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
import { logServerError } from "~/lib/errors";
import { vmPath } from "~/lib/format";
import { createVm, listClusters } from "~/vms/vms.server";
import type { ClusterCatalog, CreateVmRequest, NetworkInfo } from "~/lib/types";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Create VM · kmc" }];
}

export async function loader() {
  const clusters = await listClusters();
  return { clusters };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();

  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const sizeMode = String(form.get("sizeMode") ?? "manual");
  const instanceType = String(form.get("instanceType") ?? "").trim() || undefined;
  const preference = String(form.get("preference") ?? "").trim() || undefined;
  const cpuCoresRaw = String(form.get("cpuCores") ?? "").trim();
  const memory = String(form.get("memory") ?? "").trim() || undefined;
  const diskSize = String(form.get("diskSize") ?? "").trim();
  const storageClass = String(form.get("storageClass") ?? "").trim() || undefined;
  const imageValue = String(form.get("image") ?? "").trim();
  const network = String(form.get("network") ?? "").trim() || undefined;
  const sshPublicKey = String(form.get("sshPublicKey") ?? "").trim();
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
  if (!sshPublicKey) return { error: "SSH public key is required" };

  const [imageNamespace, imageName] = imageValue.includes("/")
    ? (imageValue.split("/") as [string, string])
    : ["vm-images", imageValue];

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
  const { clusters } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";
  const catalogFetcher = useFetcher<CatalogFetcherData>();
  const networksFetcher = useFetcher<NetworksFetcherData>();

  const form = useForm({
    initialValues: {
      cluster: "",
      namespace: "",
      name: "",
      sizeMode: "manual" as "manual" | "instancetype",
      instanceType: "",
      preference: "",
      cpuCores: 2,
      memory: "4Gi",
      diskSize: "100Gi",
      storageClass: "",
      image: "",
      network: "",
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
      sshPublicKey: (v) => (!v ? "Required" : null),
    },
  });

  const onSubmit = form.onSubmit((values) => {
    const data: Record<string, string> = {
      cluster: values.cluster,
      namespace: values.namespace,
      name: values.name,
      sizeMode: values.sizeMode,
      instanceType: values.instanceType,
      preference: values.preference,
      cpuCores: String(values.cpuCores),
      memory: values.memory,
      diskSize: values.diskSize,
      storageClass: values.storageClass,
      image: values.image,
      network: values.network,
      sshPublicKey: values.sshPublicKey,
      start: values.start ? "true" : "false",
    };
    submit(data, { method: "post" });
  });

  const catalog = catalogFetcher.data;
  const reachableClusters = clusters.filter((c) => c.reachable);

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
    if (catalog.hasInstanceTypes) {
      form.setFieldValue("sizeMode", "instancetype");
      if (!form.values.instanceType && catalog.instanceTypes[0]) {
        form.setFieldValue("instanceType", catalog.instanceTypes[0].name);
      }
      if (!form.values.preference) {
        const ubuntu = catalog.preferences.find((p) => p.name === "ubuntu");
        if (ubuntu) form.setFieldValue("preference", ubuntu.name);
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
      notifyActionError("Create failed", actionData.error);
    }
  }, [actionData]);

  const namespaceOptions = useMemo(
    () => (catalog?.namespaces ?? []).map((n) => n.name),
    [catalog],
  );
  const imageOptions = useMemo(
    () =>
      (catalog?.images ?? []).map((img) => ({
        value: `${img.namespace}/${img.name}`,
        label: `${img.name}${img.capacity ? ` (${img.capacity})` : ""}`,
      })),
    [catalog],
  );
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
  const preferenceOptions = useMemo(
    () => (catalog?.preferences ?? []).map((p) => p.name),
    [catalog],
  );
  const networkOptions = useMemo(() => {
    const nets = networksFetcher.data?.networks ?? [];
    return [
      { value: "", label: "Pod network" },
      ...nets.map((n) => {
        if (n.ipPool) {
          const { id, cidr, free, total } = n.ipPool;
          return {
            value: n.name,
            label: `${n.name} · IPAM ${id} (${free}/${total} free · ${cidr})`,
          };
        }
        return { value: n.name, label: n.name };
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
          Create virtual machine
        </Title>
        <Text size="sm" c="dimmed">
          Provision a KubeVirt VM by cloning a golden image PVC
        </Text>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Create failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <Paper
            p="md"
            radius="sm"
            style={{ background: "#12151a", border: "1px solid #1e242c" }}
          >
            <Stack gap="sm">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Placement
              </Text>
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
                nothingFoundMessage="No namespaces"
                value={form.values.namespace || null}
                error={form.errors.namespace}
                onChange={(v) => form.setFieldValue("namespace", v ?? "")}
              />
            </Stack>
          </Paper>

          <Paper
            p="md"
            radius="sm"
            style={{ background: "#12151a", border: "1px solid #1e242c" }}
          >
            <Stack gap="sm">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Identity
              </Text>
              <TextInput
                label="Name"
                placeholder="my-vm"
                required
                {...form.getInputProps("name")}
              />
            </Stack>
          </Paper>

          <Paper
            p="md"
            radius="sm"
            style={{ background: "#12151a", border: "1px solid #1e242c" }}
          >
            <Stack gap="sm">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Size
              </Text>
              {catalog?.hasInstanceTypes && (
                <>
                  <Select
                    label="Instance type"
                    data={instanceTypeOptions}
                    value={form.values.instanceType || null}
                    onChange={(v) => {
                      form.setFieldValue("instanceType", v ?? "");
                      form.setFieldValue("sizeMode", v ? "instancetype" : "manual");
                    }}
                  />
                  <Select
                    label="Preference"
                    clearable
                    data={preferenceOptions}
                    value={form.values.preference || null}
                    onChange={(v) => form.setFieldValue("preference", v ?? "")}
                  />
                </>
              )}
              {(!catalog?.hasInstanceTypes || form.values.sizeMode === "manual") && (
                <Group grow>
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
                </Group>
              )}
            </Stack>
          </Paper>

          <Paper
            p="md"
            radius="sm"
            style={{ background: "#12151a", border: "1px solid #1e242c" }}
          >
            <Stack gap="sm">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Disk
              </Text>
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
              <Select
                label="Image"
                placeholder="Select golden image PVC"
                data={imageOptions}
                required
                disabled={!catalog}
                value={form.values.image || null}
                error={form.errors.image}
                onChange={(v) => form.setFieldValue("image", v ?? "")}
              />
            </Stack>
          </Paper>

          <Paper
            p="md"
            radius="sm"
            style={{ background: "#12151a", border: "1px solid #1e242c" }}
          >
            <Stack gap="sm">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Access & network
              </Text>
              <Textarea
                label="SSH public key"
                placeholder="ssh-ed25519 AAAA… user@host"
                minRows={3}
                required
                autosize
                {...form.getInputProps("sshPublicKey")}
              />
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
                  ({selectedNetworkPool.cidr}, gateway {selectedNetworkPool.gateway}
                  ). Configured via cloud-init netplan; released when the VM is
                  deleted.
                </Text>
              ) : form.values.network ? (
                <Text size="xs" c="dimmed">
                  No IP pool configured for this Multus network — guest networking
                  is left unconfigured by kmc.
                </Text>
              ) : null}
              <Switch
                label="Start after create"
                checked={form.values.start}
                onChange={(e) => form.setFieldValue("start", e.currentTarget.checked)}
              />
            </Stack>
          </Paper>

          <Paper
            p="md"
            radius="sm"
            style={{
              background: "#12151a",
              border: "1px solid #1e242c",
              position: "sticky",
              bottom: 12,
              zIndex: 5,
            }}
          >
            <Group justify="flex-end">
              <Button component={Link} to="/" variant="default">
                Cancel
              </Button>
              <Button type="submit" loading={submitting}>
                Create VM
              </Button>
            </Group>
          </Paper>
        </Stack>
      </form>
    </Stack>
  );
}
