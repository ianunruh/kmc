import {
  ActionIcon,
  Alert,
  Button,
  Group,
  NumberInput,
  SegmentedControl,
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
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useMemo } from "react";
import {
  Link,
  redirect,
  useFetcher,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "react-router";
import type { Route } from "./+types/vms.create";
import { notifyActionError } from "~/lib/action-feedback";
import { getRequestSession } from "~/lib/auth/middleware.server";
import { logServerError } from "~/lib/errors";
import {
  expandVmLaunchNames,
  MAX_VM_LAUNCH_COUNT,
  validateDns1123Label,
  vmPath,
  vmsListPath,
} from "~/lib/format";
import { getImagePreference } from "~/lib/k8s/catalog.server";
import { KMC_MAX_EXTRA_DISKS } from "~/lib/k8s/constants";
import { listSshKeysOrEmpty } from "~/ssh-keys/ssh-keys.server";
import { FormActions, FormSection } from "~/ui";
import {
  instanceTypeSelectData,
  preferredInstanceTypeName,
} from "~/instancetypes/options";
import { createVm, listClusters } from "~/vms/vms.server";
import type {
  ClusterCatalog,
  CreateVmDiskSourceMode,
  CreateVmExtraDisk,
  CreateVmRequest,
  NetworkInfo,
} from "~/lib/types";

const MAX_NETWORK_ATTACHMENTS = 8;

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Launch VM · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const clusters = await listClusters();
  const session = getRequestSession();
  const { keys: sshKeys, error: sshKeysError } = await listSshKeysOrEmpty(
    session?.user ?? null,
  );
  const url = new URL(request.url);
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
    prefill: {
      cluster: url.searchParams.get("cluster")?.trim() || "",
      namespace: url.searchParams.get("namespace")?.trim() || "",
      diskSource:
        url.searchParams.get("diskSource") === "existingDataVolume"
          ? ("existingDataVolume" as const)
          : ("image" as const),
      existingDataVolume:
        url.searchParams.get("existingDataVolume")?.trim() ||
        url.searchParams.get("existingDataVolumeName")?.trim() ||
        "",
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();

  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const countRaw = String(form.get("count") ?? "1").trim();
  const count = Number(countRaw);
  const sizeMode = String(form.get("sizeMode") ?? "manual");
  const instanceType = String(form.get("instanceType") ?? "").trim() || undefined;
  const cpuCoresRaw = String(form.get("cpuCores") ?? "").trim();
  const memory = String(form.get("memory") ?? "").trim() || undefined;
  const diskSourceRaw = String(form.get("diskSource") ?? "image").trim();
  const diskSource: CreateVmDiskSourceMode =
    diskSourceRaw === "existingDataVolume" ? "existingDataVolume" : "image";
  const diskSize = String(form.get("diskSize") ?? "").trim();
  const storageClass = String(form.get("storageClass") ?? "").trim() || undefined;
  const imageValue = String(form.get("image") ?? "").trim();
  const existingDataVolume = String(form.get("existingDataVolume") ?? "").trim();
  const networksRaw = String(form.get("networks") ?? "").trim();
  const multusNetworks = networksRaw
    ? networksRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  /** Multus + pod dual-home (default on); form sends "false" to opt out. */
  const includePodNetwork = form.get("includePodNetwork") !== "false";
  const sshKeyMode = String(form.get("sshKeyMode") ?? "paste").trim();
  const savedSshKeyId = String(form.get("savedSshKeyId") ?? "").trim();
  let sshPublicKey = String(form.get("sshPublicKey") ?? "").trim();
  const start = form.get("start") !== "false";
  const installGuestAgent = form.get("installGuestAgent") !== "false";

  if (!cluster) return { error: "Cluster is required" };
  if (!namespace) return { error: "Namespace is required" };

  const expanded = expandVmLaunchNames(name, count);
  if ("error" in expanded) return { error: expanded.error };
  const { names } = expanded;

  if (names.length > 1 && diskSource === "existingDataVolume") {
    return {
      error:
        "Launching multiple VMs requires a new disk from image — an existing DataVolume can only back one VM",
    };
  }

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

  const basePayload: Omit<CreateVmRequest, "name"> = {
    cluster,
    namespace,
    sshPublicKey,
    start,
    installGuestAgent,
    diskSource,
  };

  if (diskSource === "existingDataVolume") {
    if (!existingDataVolume) return { error: "DataVolume is required" };
    const dvErr = validateDns1123Label(existingDataVolume);
    if (dvErr) return { error: `DataVolume: ${dvErr}` };
    basePayload.existingDataVolumeName = existingDataVolume;
  } else {
    if (!diskSize) return { error: "Disk size is required" };
    if (!imageValue) return { error: "Image is required" };
    const [imageNamespace, imageName] = imageValue.includes("/")
      ? (imageValue.split("/") as [string, string])
      : ["vm-images", imageValue];
    // Preference comes from the golden image PVC label, not a form field.
    const preference = await getImagePreference(cluster, imageNamespace, imageName);
    basePayload.diskSize = diskSize;
    basePayload.storageClass = storageClass;
    basePayload.image = { kind: "pvc", namespace: imageNamespace, name: imageName };
    basePayload.preference = preference;
  }

  if (sizeMode === "instancetype" && instanceType) {
    basePayload.instanceType = instanceType;
  } else {
    const cpuCores = Number(cpuCoresRaw || 1);
    if (!Number.isFinite(cpuCores) || cpuCores < 1) {
      return { error: "CPU cores must be a positive number" };
    }
    if (!memory) return { error: "Memory is required" };
    basePayload.cpuCores = cpuCores;
    basePayload.memory = memory;
  }

  if (multusNetworks.length > 0) {
    const unique = new Set(multusNetworks);
    if (unique.size !== multusNetworks.length) {
      return { error: "Each Multus network can only be attached once" };
    }
    if (multusNetworks.length > MAX_NETWORK_ATTACHMENTS) {
      return {
        error: `At most ${MAX_NETWORK_ATTACHMENTS} Multus network attachments are supported`,
      };
    }
    basePayload.networks = multusNetworks.map((multusNetworkName) => ({
      multusNetworkName,
    }));
    // Default dual-home; only send false when the user opts out.
    basePayload.includePodNetwork = includePodNetwork;
  }

  // Optional secondary blank disks (JSON array from the form).
  const extraDisksRaw = String(form.get("extraDisks") ?? "").trim();
  if (extraDisksRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extraDisksRaw);
    } catch {
      return { error: "Invalid extraDisks payload" };
    }
    if (!Array.isArray(parsed)) {
      return { error: "extraDisks must be an array" };
    }
    if (parsed.length > KMC_MAX_EXTRA_DISKS) {
      return {
        error: `At most ${KMC_MAX_EXTRA_DISKS} secondary disks are supported`,
      };
    }
    const extraDisks: CreateVmExtraDisk[] = [];
    const usedNames = new Set<string>();
    for (let i = 0; i < parsed.length; i++) {
      const row = parsed[i] as { name?: string; size?: string; storageClass?: string };
      const size = String(row?.size ?? "").trim();
      if (!size) return { error: `Additional disk ${i + 1}: size is required` };
      const name = String(row?.name ?? "").trim();
      if (name) {
        const nameErr = validateDns1123Label(name);
        if (nameErr) return { error: `Additional disk ${i + 1}: ${nameErr}` };
        if (name === "root" || name === "cloudinit") {
          return { error: `Additional disk ${i + 1}: name "${name}" is reserved` };
        }
        if (usedNames.has(name)) {
          return { error: `Duplicate additional disk name "${name}"` };
        }
        usedNames.add(name);
      }
      const storageClass = String(row?.storageClass ?? "").trim() || undefined;
      extraDisks.push({
        source: "blank",
        size,
        ...(name ? { name } : {}),
        ...(storageClass ? { storageClass } : {}),
      });
    }
    if (extraDisks.length > 0) {
      basePayload.extraDisks = extraDisks;
    }
  }

  const created: string[] = [];
  try {
    for (const vmName of names) {
      await createVm({ ...basePayload, name: vmName });
      created.push(vmName);
    }
  } catch (err) {
    const failedName = names[created.length] ?? name;
    const detail = logServerError("vm.create", err, {
      cluster,
      namespace,
      name: failedName,
      count: names.length,
      created,
    });
    if (created.length > 0) {
      return {
        error: `Created ${created.join(", ")} then failed on ${failedName}: ${detail}`,
      };
    }
    return { error: detail };
  }

  if (names.length === 1) {
    return redirect(
      vmPath({
        cluster,
        namespace,
        name: names[0]!,
      }),
    );
  }
  return redirect(vmsListPath({ cluster, namespace }));
}

type CatalogFetcherData = ClusterCatalog;
type NetworksFetcherData = { networks: NetworkInfo[] };
type DataVolumesFetcherData = {
  dataVolumes: Array<{
    name: string;
    phase: string;
    size?: string;
    retainedFromVm?: string;
  }>;
};

export default function CreateVmPage({ loaderData, actionData }: Route.ComponentProps) {
  const { clusters, sshKeys, sshKeysError, signedIn, prefill } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const [searchParams] = useSearchParams();
  const submitting = navigation.state === "submitting";
  const catalogFetcher = useFetcher<CatalogFetcherData>();
  const networksFetcher = useFetcher<NetworksFetcherData>();
  const dataVolumesFetcher = useFetcher<DataVolumesFetcherData>();
  const hasSavedKeys = sshKeys.length > 0;
  const reachableClusters = clusters.filter((c) => c.reachable);
  const defaultCluster =
    (prefill.cluster && reachableClusters.some((c) => c.id === prefill.cluster)
      ? prefill.cluster
      : undefined) ??
    reachableClusters[0]?.id ??
    "";

  const form = useForm({
    initialValues: {
      cluster: defaultCluster,
      namespace: prefill.namespace,
      name: "",
      count: 1,
      sizeMode: "manual" as "manual" | "instancetype",
      instanceType: "",
      cpuCores: 2,
      memory: "4Gi",
      diskSource: prefill.diskSource as CreateVmDiskSourceMode,
      diskSize: "100Gi",
      storageClass: "",
      image: "",
      existingDataVolume: prefill.existingDataVolume,
      /** Multus NAD names in attachment order; empty = pod network only */
      networks: [] as string[],
      /**
       * Dual-home Multus + pod/masquerade (pod first). Enables browser Terminal
       * via KubeVirt port-forward. Opt out for Multus-only guests.
       */
      includePodNetwork: true,
      /**
       * Optional secondary blank disks (scsi, hotpluggable).
       * Each row: optional name, size, optional storageClass.
       */
      extraDisks: [] as Array<{
        name: string;
        size: string;
        storageClass: string;
      }>,
      sshKeyMode: (hasSavedKeys ? "saved" : "paste") as "saved" | "paste",
      savedSshKeyId: hasSavedKeys ? sshKeys[0]!.id : "",
      sshPublicKey: "",
      start: true,
      /** Install qemu-guest-agent via cloud-init (soft reboot / guest OS info). */
      installGuestAgent: true,
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      namespace: (v) => (!v ? "Required" : null),
      name: (v, values) => {
        const expanded = expandVmLaunchNames(v, values.count);
        if ("error" in expanded) return expanded.error;
        return null;
      },
      count: (v, values) => {
        if (!Number.isInteger(v) || v < 1) return "At least 1";
        if (v > MAX_VM_LAUNCH_COUNT) return `Max ${MAX_VM_LAUNCH_COUNT}`;
        if (v > 1 && values.diskSource === "existingDataVolume") {
          return "Count must be 1 when reusing an existing DataVolume";
        }
        return null;
      },
      diskSize: (v, values) =>
        values.diskSource === "image" && !v ? "Required" : null,
      image: (v, values) =>
        values.diskSource === "image" && !v ? "Required" : null,
      existingDataVolume: (v, values) => {
        if (values.diskSource !== "existingDataVolume") return null;
        return validateDns1123Label(v);
      },
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
      count: String(values.count),
      sizeMode: values.sizeMode,
      instanceType: values.instanceType,
      cpuCores: String(values.cpuCores),
      memory: values.memory,
      diskSource: values.diskSource,
      networks: values.networks.filter(Boolean).join(","),
      includePodNetwork: values.includePodNetwork ? "true" : "false",
      sshKeyMode: values.sshKeyMode,
      savedSshKeyId: values.savedSshKeyId,
      sshPublicKey: values.sshPublicKey,
      start: values.start ? "true" : "false",
      installGuestAgent: values.installGuestAgent ? "true" : "false",
    };
    if (values.diskSource === "existingDataVolume") {
      data.existingDataVolume = values.existingDataVolume;
    } else {
      data.diskSize = values.diskSize;
      data.storageClass = values.storageClass;
      data.image = values.image;
    }
    if (values.extraDisks.length > 0) {
      data.extraDisks = JSON.stringify(
        values.extraDisks.map((d) => ({
          name: d.name.trim() || undefined,
          size: d.size.trim(),
          storageClass: d.storageClass.trim() || undefined,
        })),
      );
    }
    submit(data, { method: "post" });
  });

  // Honor deep-link query params if the user navigates with them after mount.
  useEffect(() => {
    const ds = searchParams.get("diskSource");
    const dv =
      searchParams.get("existingDataVolume") ??
      searchParams.get("existingDataVolumeName");
    if (ds === "existingDataVolume") {
      form.setFieldValue("diskSource", "existingDataVolume");
    }
    if (dv?.trim()) {
      form.setFieldValue("existingDataVolume", dv.trim());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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
    if (
      form.values.diskSource !== "existingDataVolume" ||
      !form.values.cluster ||
      !form.values.namespace
    ) {
      return;
    }
    dataVolumesFetcher.load(
      `/api/datavolumes/${form.values.cluster}?namespace=${encodeURIComponent(form.values.namespace)}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.cluster, form.values.namespace, form.values.diskSource]);

  useEffect(() => {
    if (!catalog) return;
    const namespaceNames = catalog.namespaces.map((n) => n.name);
    if (!form.values.namespace || !namespaceNames.includes(form.values.namespace)) {
      // Prefer prefill namespace when it is still valid.
      if (prefill.namespace && namespaceNames.includes(prefill.namespace)) {
        form.setFieldValue("namespace", prefill.namespace);
      } else {
        form.setFieldValue("namespace", namespaceNames[0] ?? "");
      }
    }
    if (catalog.hasInstanceTypes) {
      form.setFieldValue("sizeMode", "instancetype");
      if (!form.values.instanceType) {
        const preferred = preferredInstanceTypeName(catalog.instanceTypes);
        if (preferred) form.setFieldValue("instanceType", preferred);
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
    // Only seed a default when the user has not chosen attachments yet.
    if (form.values.networks.length > 0) return;
    const bridge = networks.find((n) => n.name === "bridge-external");
    if (bridge) {
      form.setFieldValue("networks", [bridge.name]);
    } else if (networks[0]) {
      form.setFieldValue("networks", [networks[0].name]);
    } else {
      form.setFieldValue("networks", []);
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
    () => instanceTypeSelectData(catalog?.instanceTypes ?? []),
    [catalog],
  );
  const availableNetworks = useMemo(
    () => networksFetcher.data?.networks ?? [],
    [networksFetcher.data],
  );

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

  const networkLabel = (n: NetworkInfo) => {
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
      return bits.join(" · ");
    }
    const bits = [n.name, kindPart, vlanPart].filter(Boolean);
    return bits.join(" · ");
  };

  const selectedNetworkInfos = useMemo(() => {
    return form.values.networks
      .map((name) => availableNetworks.find((n) => n.name === name))
      .filter((n): n is NetworkInfo => n != null);
  }, [availableNetworks, form.values.networks]);

  const launchNamePreview = useMemo(() => {
    const expanded = expandVmLaunchNames(form.values.name, form.values.count);
    if ("error" in expanded) return null;
    return expanded.names;
  }, [form.values.name, form.values.count]);

  const setNetworkAt = (index: number, value: string) => {
    const next = [...form.values.networks];
    next[index] = value;
    form.setFieldValue("networks", next);
  };

  const removeNetworkAt = (index: number) => {
    form.setFieldValue(
      "networks",
      form.values.networks.filter((_, i) => i !== index),
    );
  };

  const addNetwork = () => {
    if (form.values.networks.length >= MAX_NETWORK_ATTACHMENTS) return;
    const used = new Set(form.values.networks);
    const next = availableNetworks.find((n) => !used.has(n.name));
    form.setFieldValue("networks", [
      ...form.values.networks,
      next?.name ?? "",
    ]);
  };

  const optionsForSlot = (index: number) => {
    const current = form.values.networks[index] ?? "";
    const usedElsewhere = new Set(
      form.values.networks.filter((_, i) => i !== index && form.values.networks[i]),
    );
    return availableNetworks
      .filter((n) => n.name === current || !usedElsewhere.has(n.name))
      .map((n) => ({ value: n.name, label: networkLabel(n) }));
  };

  return (
    <Stack gap="md" pb={80}>
      <div>
        <Title order={2} size="h3">
          Launch virtual machine
          {form.values.count > 1 ? "s" : ""}
        </Title>
        <Text size="sm" c="dimmed">
          Provision one or more KubeVirt VMs from a golden image, or a single VM
          from an existing DataVolume
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
                  form.setFieldValue("networks", []);
                  form.setFieldValue("existingDataVolume", "");
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
                onChange={(v) => {
                  form.setFieldValue("namespace", v ?? "");
                  form.setFieldValue("networks", []);
                  form.setFieldValue("existingDataVolume", "");
                }}
              />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <TextInput
                label={form.values.count > 1 ? "Base name" : "Name"}
                placeholder="my-vm"
                description={
                  form.values.count > 1
                    ? "Instances are named base-1, base-2, …"
                    : undefined
                }
                required
                autoFocus
                {...form.getInputProps("name")}
              />
              <NumberInput
                label="Count"
                description={`1–${MAX_VM_LAUNCH_COUNT} identical VMs`}
                min={1}
                max={MAX_VM_LAUNCH_COUNT}
                clampBehavior="strict"
                allowDecimal={false}
                required
                value={form.values.count}
                error={form.errors.count}
                onChange={(v) => {
                  const n = typeof v === "number" ? v : Number(v);
                  form.setFieldValue(
                    "count",
                    Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1,
                  );
                  if (
                    Number.isFinite(n) &&
                    n > 1 &&
                    form.values.diskSource === "existingDataVolume"
                  ) {
                    form.setFieldValue("diskSource", "image");
                  }
                }}
              />
            </SimpleGrid>
            {launchNamePreview && launchNamePreview.length > 1 ? (
              <Text size="xs" c="dimmed">
                Will create{" "}
                <Text span ff="monospace" c="gray.4">
                  {launchNamePreview.length <= 8
                    ? launchNamePreview.join(", ")
                    : `${launchNamePreview.slice(0, 6).join(", ")} … ${launchNamePreview[launchNamePreview.length - 1]}`}
                </Text>
              </Text>
            ) : null}
          </FormSection>

          <FormSection title="Size & disk">
            {catalog?.hasInstanceTypes && (
              <Select
                label="Instance type"
                description="Grouped by common-instancetypes class (u1 general purpose is a good default)"
                data={instanceTypeOptions}
                searchable
                nothingFoundMessage="No instance types match"
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
            <div>
              <Text size="sm" fw={500} mb={6}>
                Disk source
              </Text>
              <SegmentedControl
                fullWidth
                value={form.values.diskSource}
                onChange={(v) => {
                  if (v === "existingDataVolume" && form.values.count > 1) {
                    form.setFieldValue("count", 1);
                  }
                  form.setFieldValue(
                    "diskSource",
                    v === "existingDataVolume" ? "existingDataVolume" : "image",
                  );
                }}
                data={[
                  { label: "New disk from image", value: "image" },
                  {
                    label: "Existing DataVolume",
                    value: "existingDataVolume",
                    disabled: form.values.count > 1,
                  },
                ]}
              />
              {form.values.count > 1 ? (
                <Text size="xs" c="dimmed" mt={6}>
                  Multi-launch clones a new disk per VM from the golden image.
                </Text>
              ) : null}
            </div>

            {form.values.diskSource === "image" ? (
              <>
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
              </>
            ) : (
              <>
                <Select
                  label="DataVolume"
                  placeholder={
                    form.values.namespace
                      ? "Select a Succeeded DataVolume"
                      : "Select a namespace first"
                  }
                  description="Same-namespace disks only. Volume name may differ from the new VM name."
                  data={dataVolumeOptions}
                  required
                  searchable
                  disabled={
                    !form.values.cluster ||
                    !form.values.namespace ||
                    dataVolumesFetcher.state === "loading"
                  }
                  nothingFoundMessage="No Succeeded DataVolumes in this namespace"
                  value={form.values.existingDataVolume || null}
                  error={form.errors.existingDataVolume}
                  onChange={(v) => form.setFieldValue("existingDataVolume", v ?? "")}
                />
                <Alert color="yellow" variant="light" title="Existing OS disk">
                  Reusing a disk that already has an OS may skip cloud-init on first boot;
                  new SSH keys from this form may not apply until cloud-init is reset inside
                  the guest.
                </Alert>
                <Alert color="gray" variant="light" title="After a retain-delete">
                  If you just deleted the previous VM, wait until its VMI/pod is gone before
                  launching, or start may fail while the disk is still attached.
                </Alert>
              </>
            )}
          </FormSection>

          <FormSection title="Additional disks">
            <Text size="sm" c="dimmed">
              Optional blank data disks (scsi, up to {KMC_MAX_EXTRA_DISKS}). Format and
              mount inside the guest.
            </Text>
            {form.values.extraDisks.length === 0 ? (
              <Text size="sm" c="dimmed">
                No extra disks — root disk only. You can also attach disks later from the
                VM Storage tab (including existing DataVolumes).
              </Text>
            ) : (
              <Stack gap="sm">
                {form.values.extraDisks.map((disk, index) => (
                  <SimpleGrid
                    key={index}
                    cols={{ base: 1, sm: 4 }}
                    spacing="sm"
                    style={{ alignItems: "end" }}
                  >
                    <TextInput
                      label={index === 0 ? "Name" : undefined}
                      placeholder={`disk-${index + 1}`}
                      description={index === 0 ? "Optional" : undefined}
                      value={disk.name}
                      onChange={(e) => {
                        const next = [...form.values.extraDisks];
                        next[index] = {
                          ...next[index]!,
                          name: e.currentTarget.value,
                        };
                        form.setFieldValue("extraDisks", next);
                      }}
                    />
                    <TextInput
                      label={index === 0 ? "Size" : undefined}
                      placeholder="10Gi"
                      required
                      value={disk.size}
                      onChange={(e) => {
                        const next = [...form.values.extraDisks];
                        next[index] = {
                          ...next[index]!,
                          size: e.currentTarget.value,
                        };
                        form.setFieldValue("extraDisks", next);
                      }}
                    />
                    <Select
                      label={index === 0 ? "Storage class" : undefined}
                      placeholder="Default"
                      clearable
                      data={storageOptions}
                      value={disk.storageClass || null}
                      onChange={(v) => {
                        const next = [...form.values.extraDisks];
                        next[index] = {
                          ...next[index]!,
                          storageClass: v ?? "",
                        };
                        form.setFieldValue("extraDisks", next);
                      }}
                    />
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label="Remove disk"
                      onClick={() => {
                        form.setFieldValue(
                          "extraDisks",
                          form.values.extraDisks.filter((_, i) => i !== index),
                        );
                      }}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </SimpleGrid>
                ))}
              </Stack>
            )}
            <Button
              type="button"
              variant="light"
              size="xs"
              leftSection={<IconPlus size={14} />}
              disabled={form.values.extraDisks.length >= KMC_MAX_EXTRA_DISKS}
              onClick={() => {
                if (form.values.extraDisks.length >= KMC_MAX_EXTRA_DISKS) return;
                form.setFieldValue("extraDisks", [
                  ...form.values.extraDisks,
                  {
                    name: "",
                    size: "10Gi",
                    storageClass: form.values.storageClass || "",
                  },
                ]);
              }}
            >
              Add data disk
            </Button>
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
            <Stack gap="xs">
              <div>
                <Text size="sm" fw={500}>
                  Networks
                </Text>
                <Text size="xs" c="dimmed">
                  Multus attachments in order (first Multus is primary for the
                  default route when IPAM applies). Leave empty for pod network
                  only (masquerade NAT via virt-launcher — works with Ingress).
                  With Multus, a pod NIC is added first by default so Terminal
                  port-forward works.
                </Text>
              </div>
              {form.values.networks.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No Multus attachments — VM will use the pod network
                  (masquerade).
                </Text>
              ) : (
                form.values.networks.map((name, index) => (
                  <Group key={`net-${index}`} gap="xs" align="flex-end" wrap="nowrap">
                    <Select
                      label={
                        form.values.networks.length > 1
                          ? index === 0
                            ? "Primary Multus"
                            : `Multus NIC ${index + 1}`
                          : "Multus network"
                      }
                      placeholder="Select Multus network"
                      description={
                        form.values.networks.length > 1 && index === 0
                          ? "Preferred for default route when the pool has a gateway"
                          : undefined
                      }
                      data={optionsForSlot(index)}
                      searchable
                      disabled={
                        !form.values.namespace ||
                        networksFetcher.state === "loading"
                      }
                      nothingFoundMessage="No Multus NADs in this namespace"
                      value={name || null}
                      onChange={(v) => setNetworkAt(index, v ?? "")}
                      style={{ flex: 1 }}
                    />
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={`Remove network ${index + 1}`}
                      onClick={() => removeNetworkAt(index)}
                      mb={4}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                ))
              )}
              {form.values.networks.length > 0 ? (
                <Switch
                  label="Include pod network (management)"
                  description="Adds a masquerade pod NIC as the first interface so browser Terminal (SSH port-forward) and Ingress-style access work. Multus stays the default route. Turn off for Multus-only guests."
                  checked={form.values.includePodNetwork}
                  onChange={(e) =>
                    form.setFieldValue(
                      "includePodNetwork",
                      e.currentTarget.checked,
                    )
                  }
                />
              ) : null}
              <Group gap="sm">
                <Button
                  type="button"
                  variant="light"
                  size="xs"
                  leftSection={<IconPlus size={14} />}
                  disabled={
                    !form.values.namespace ||
                    form.values.networks.length >= MAX_NETWORK_ATTACHMENTS ||
                    (availableNetworks.length > 0 &&
                      form.values.networks.filter(Boolean).length >=
                        availableNetworks.length)
                  }
                  onClick={addNetwork}
                >
                  Add network
                </Button>
                {form.values.networks.length > 0 ? (
                  <Button
                    type="button"
                    variant="subtle"
                    size="xs"
                    color="gray"
                    onClick={() => form.setFieldValue("networks", [])}
                  >
                    Use pod network only
                  </Button>
                ) : null}
              </Group>
              {selectedNetworkInfos.some((n) => n.ipPool) ? (
                <Stack gap={4}>
                  {selectedNetworkInfos.map((n) =>
                    n.ipPool ? (
                      <Text key={n.name} size="xs" c="dimmed">
                        <Text span ff="monospace" c="gray.4">
                          {n.name}
                        </Text>
                        : auto-assigns from pool{" "}
                        <Text span ff="monospace" c="gray.4">
                          {n.ipPool.id}
                        </Text>{" "}
                        ({n.ipPool.cidr}
                        {n.ipPool.gateway
                          ? `, gateway ${n.ipPool.gateway}`
                          : ", no default route"}
                        )
                      </Text>
                    ) : n.name ? (
                      <Text key={n.name} size="xs" c="dimmed">
                        <Text span ff="monospace" c="gray.4">
                          {n.name}
                        </Text>
                        : no IP pool — guest networking left unconfigured by kmc
                      </Text>
                    ) : null,
                  )}
                  <Text size="xs" c="dimmed">
                    Static addresses are injected via cloud-init netplan and
                    released when the VM is deleted.
                  </Text>
                </Stack>
              ) : form.values.networks.some(Boolean) ? (
                <Text size="xs" c="dimmed">
                  No IP pool configured for the selected Multus network(s) —
                  guest networking is left unconfigured by kmc.
                </Text>
              ) : null}
            </Stack>
          </FormSection>

          <FormSection title="Guest setup">
            <Switch
              label="Install qemu-guest-agent"
              description="Cloud-init installs and enables the agent on first boot (soft reboot, guest OS info). Needs package repos reachable from the guest."
              checked={form.values.installGuestAgent}
              onChange={(e) =>
                form.setFieldValue("installGuestAgent", e.currentTarget.checked)
              }
            />
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
                {form.values.count > 1
                  ? `Launch ${form.values.count} VMs`
                  : "Launch VM"}
              </Button>
            </Group>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
