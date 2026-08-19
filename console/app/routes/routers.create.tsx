import {
  Alert,
  Button,
  Code,
  MultiSelect,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import {
  Link,
  redirect,
  useFetcher,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "react-router";
import type { Route } from "./+types/routers.create";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { getRequestSession } from "~/lib/auth/middleware.server";
import { logServerError } from "~/lib/errors";
import { routerPath } from "~/lib/format";
import {
  instanceTypeSelectData,
  preferredInstanceTypeName,
} from "~/instancetypes/options";
import { getClusterCatalog } from "~/lib/k8s/catalog.server";
import { getConfiguredContexts } from "~/lib/k8s/clients.server";
import { listSshKeysOrEmpty } from "~/ssh-keys/ssh-keys.server";
import { listClusters } from "~/vms/vms.server";
import { createRouter, listRouterAttachableVpcs } from "~/vpcs/routers.server";
import { listPublicEgressNetworks } from "~/vpcs/vpcs.server";
import { tracedLoader } from "~/lib/request-traces.server";

type AttachableVpc = Awaited<ReturnType<typeof listRouterAttachableVpcs>>[number];
type AttachableFetcherData = { attachable: AttachableVpc[] };

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Create router · kmc" }];
}

export const loader = tracedLoader(async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);
  /** Only set when present in the URL (locks the field). Do not default. */
  const preCluster = url.searchParams.get("cluster")?.trim() || "";
  const preNamespace = url.searchParams.get("namespace")?.trim() || "";
  const preVpc = url.searchParams.get("vpc")?.trim() || "";

  const clusters = await listClusters();
  const contexts = getConfiguredContexts();
  const defaultCluster = preCluster || contexts[0] || clusters[0]?.id || "";

  let catalog: Awaited<ReturnType<typeof getClusterCatalog>> | null = null;
  let catalogError: string | null = null;
  if (defaultCluster) {
    try {
      catalog = await getClusterCatalog(defaultCluster);
    } catch (err) {
      catalogError = err instanceof Error ? err.message : String(err);
    }
  }

  const session = getRequestSession();
  const { keys: sshKeys, error: sshKeysError } = await listSshKeysOrEmpty(
    session?.user ?? null,
  );

  let attachable: Awaited<ReturnType<typeof listRouterAttachableVpcs>> = [];
  if (defaultCluster && preNamespace) {
    try {
      attachable = await listRouterAttachableVpcs(defaultCluster, preNamespace);
    } catch {
      attachable = [];
    }
  }

  const publicNetworks = defaultCluster
    ? await listPublicEgressNetworks(defaultCluster)
    : [];

  return {
    clusters,
    contexts,
    preCluster,
    defaultCluster,
    preNamespace,
    preVpc,
    catalog,
    catalogError,
    attachable,
    publicNetworks,
    sshKeys: sshKeys.map((k) => ({
      id: k.id,
      name: k.name,
      publicKey: k.publicKey,
      fingerprint: k.fingerprint,
    })),
    sshKeysError: sshKeysError ?? null,
    signedIn: Boolean(session?.user),
  };
});

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const vpcNames = form
    .getAll("vpcName")
    .map((v) => String(v).trim())
    .filter(Boolean);
  // Back-compat: single field if client only sent one
  if (vpcNames.length === 0) {
    const one = String(form.get("vpcName") ?? "").trim();
    if (one) vpcNames.push(one);
  }
  const externalMultusNetwork =
    String(form.get("externalMultusNetwork") ?? "").trim() || undefined;
  const sizeMode = String(form.get("sizeMode") ?? "manual");
  const instanceType = String(form.get("instanceType") ?? "").trim() || undefined;
  const cpuCoresRaw = String(form.get("cpuCores") ?? "").trim();
  const memory = String(form.get("memory") ?? "").trim() || undefined;
  const diskSize = String(form.get("diskSize") ?? "").trim() || "10Gi";
  const storageClass = String(form.get("storageClass") ?? "").trim() || undefined;
  const imageValue = String(form.get("image") ?? "").trim();
  const sshKeyMode = String(form.get("sshKeyMode") ?? "paste").trim();
  const savedSshKeyId = String(form.get("savedSshKeyId") ?? "").trim();
  let sshPublicKey = String(form.get("sshPublicKey") ?? "").trim();

  if (!cluster || !namespace || !name) {
    return { error: "Cluster, namespace, and name are required" };
  }
  if (vpcNames.length === 0) return { error: "Select at least one VPC to attach" };
  if (!imageValue) return { error: "Image is required" };

  if (sshKeyMode === "saved") {
    if (!savedSshKeyId) return { error: "Select an SSH key" };
    const session = getRequestSession();
    if (!session?.user) {
      return {
        error: "Sign in to use a saved SSH key, or paste a key instead",
      };
    }
    const { keys, error: listErr } = await listSshKeysOrEmpty(session.user);
    if (listErr) return { error: `Could not load SSH keys: ${listErr}` };
    const match = keys.find((k) => k.id === savedSshKeyId);
    if (!match) {
      return {
        error: "Selected SSH key was not found — pick another or paste",
      };
    }
    sshPublicKey = match.publicKey;
  }
  if (!sshPublicKey) return { error: "SSH public key is required" };

  const [imageNamespace, imageName] = imageValue.includes("/")
    ? (imageValue.split("/") as [string, string])
    : ["vm-images", imageValue];

  try {
    const base = {
      cluster,
      namespace,
      name,
      vpcNames,
      externalMultusNetwork,
      sshPublicKey,
      diskSize,
      storageClass,
      image: {
        kind: "pvc" as const,
        namespace: imageNamespace,
        name: imageName,
      },
      start: true,
    };

    if (sizeMode === "instancetype" && instanceType) {
      await createRouter({ ...base, instanceType });
    } else {
      const cpuCores = Number(cpuCoresRaw || 1);
      if (!Number.isFinite(cpuCores) || cpuCores < 1) {
        return { error: "CPU cores must be a positive number" };
      }
      if (!memory) return { error: "Memory is required" };
      await createRouter({ ...base, cpuCores, memory });
    }

    return redirect(routerPath({ cluster, namespace, name }));
  } catch (err) {
    return {
      error: logServerError("router.create", err, {
        cluster,
        namespace,
        name,
        vpcNames,
      }),
    };
  }
}

export default function CreateRouterPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    clusters,
    contexts,
    preCluster,
    defaultCluster,
    preNamespace,
    preVpc,
    catalog,
    catalogError,
    attachable,
    publicNetworks,
    sshKeys,
    sshKeysError,
    signedIn,
  } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const [searchParams] = useSearchParams();
  const submitting = navigation.state === "submitting";
  const attachableFetcher = useFetcher<AttachableFetcherData>();

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Router create failed", actionData.error);
    }
  }, [actionData]);

  const imageOptions = useMemo(() => {
    if (!catalog) return [];
    return catalog.images.map((img) => ({
      value: `${img.namespace}/${img.name}`,
      label: `${img.name}${img.capacity ? ` (${img.capacity})` : ""}`,
    }));
  }, [catalog]);

  const hasInstanceTypes = Boolean(catalog?.hasInstanceTypes);
  const instanceTypeOptions = useMemo(
    () => instanceTypeSelectData(catalog?.instanceTypes ?? []),
    [catalog],
  );

  const defaultImage =
    imageOptions.find((o) => o.value.includes("ubuntu"))?.value ??
    imageOptions[0]?.value ??
    "";
  const defaultInstanceType = preferredInstanceTypeName(catalog?.instanceTypes ?? []);

  const form = useForm({
    initialValues: {
      cluster: defaultCluster,
      namespace: preNamespace || searchParams.get("namespace") || "",
      name: preVpc ? `${preVpc}-router`.slice(0, 63) : "edge",
      vpcNames: [] as string[],
      externalMultusNetwork: publicNetworks[0]?.multusNetwork ?? "",
      enableExternal: Boolean(publicNetworks[0]),
      image: defaultImage,
      sizeMode: (hasInstanceTypes && defaultInstanceType ? "instancetype" : "manual") as
        "instancetype" | "manual",
      instanceType: defaultInstanceType ?? "",
      cpuCores: 1,
      memory: "1Gi",
      diskSize: "10Gi",
      storageClass: catalog?.defaultStorageClass ?? "",
      sshKeyMode: (signedIn && sshKeys.length > 0 ? "saved" : "paste") as
        "saved" | "paste",
      savedSshKeyId: sshKeys[0]?.id ?? "",
      sshPublicKey: "",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      namespace: (v) => (!v ? "Required" : null),
      name: (v) =>
        !v.trim()
          ? "Required"
          : !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v.trim())
            ? "DNS-1123 label"
            : null,
      vpcNames: (v) => (!v || v.length === 0 ? "Select at least one VPC" : null),
      image: (v) => (!v ? "Required" : null),
      instanceType: (v, values) =>
        values.sizeMode === "instancetype" && !v.trim() ? "Required" : null,
      sshPublicKey: (v, values) =>
        values.sshKeyMode === "paste" && !v.trim() ? "Required" : null,
      savedSshKeyId: (v, values) =>
        values.sshKeyMode === "saved" && !v ? "Select a key" : null,
    },
  });

  // Reload attachable VPCs whenever cluster/namespace change (loader only has
  // them when ?namespace= was present on first paint).
  useEffect(() => {
    const cluster = form.values.cluster?.trim();
    const namespace = form.values.namespace?.trim();
    if (!cluster || !namespace) return;
    attachableFetcher.load(
      `/api/router-attachable/${encodeURIComponent(cluster)}?namespace=${encodeURIComponent(namespace)}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-fetch on placement change
  }, [form.values.cluster, form.values.namespace]);

  const liveAttachable: AttachableVpc[] =
    attachableFetcher.data?.attachable ?? attachable;

  /** VPCs with private IPAM that can accept a new router interface. */
  const freeVpcs = liveAttachable.filter((v) => v.cidr && !v.attachedRouter);
  /** All known VPCs — blocked ones stay visible with a reason. */
  const vpcSelectData = liveAttachable.map((v) => {
    if (!v.cidr) {
      return {
        value: v.name,
        label: `${v.name} (no private CIDR)`,
        disabled: true,
      };
    }
    const base = `${v.name} · ${v.cidr}${v.gateway ? ` gw ${v.gateway}` : ""}`;
    if (v.attachedRouter) {
      return {
        value: v.name,
        label: `${base} (router: ${v.attachedRouter})`,
        disabled: true,
      };
    }
    return { value: v.name, label: base, disabled: false };
  });

  // Prefill / prune selection when free list changes
  useEffect(() => {
    const freeNames = new Set(freeVpcs.map((v) => v.name));
    const current = form.values.vpcNames.filter((n) => freeNames.has(n));
    if (current.length !== form.values.vpcNames.length) {
      form.setFieldValue("vpcNames", current);
      return;
    }
    if (current.length === 0 && freeVpcs.length > 0) {
      const pick = preVpc && freeNames.has(preVpc) ? preVpc : freeVpcs[0]!.name;
      form.setFieldValue("vpcNames", [pick]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- freeVpcs identity via names
  }, [freeVpcs.map((v) => v.name).join(","), preVpc]);

  const preVpcBlocked = preVpc
    ? liveAttachable.find((v) => v.name === preVpc)
    : undefined;
  const preVpcBlockedReason = preVpcBlocked
    ? preVpcBlocked.attachedRouter
      ? `VPC "${preVpc}" is already attached to router ${preVpcBlocked.attachedRouter}.`
      : !preVpcBlocked.cidr
        ? `VPC "${preVpc}" has no private CIDR — enable IPAM first.`
        : null
    : preVpc && form.values.namespace
      ? attachableFetcher.state !== "idle"
        ? null
        : `VPC "${preVpc}" was not found in this namespace (or is not a kmc VPC).`
      : null;

  const nsOptions = useMemo(() => {
    const fromCatalog = catalog?.namespaces ?? [];
    const set = new Set(fromCatalog.map((n) => n.name));
    if (preNamespace) set.add(preNamespace);
    return Array.from(set).sort();
  }, [catalog, preNamespace]);

  const blocked = Boolean(catalogError) || !catalog;
  const attachableLoading =
    Boolean(form.values.cluster && form.values.namespace) &&
    attachableFetcher.state !== "idle" &&
    !attachableFetcher.data;

  const onSubmit = form.onSubmit((values) => {
    const fd = new FormData();
    fd.set("cluster", values.cluster);
    fd.set("namespace", values.namespace.trim());
    fd.set("name", values.name.trim());
    for (const vpc of values.vpcNames) {
      fd.append("vpcName", vpc);
    }
    if (values.enableExternal && values.externalMultusNetwork) {
      fd.set("externalMultusNetwork", values.externalMultusNetwork);
    }
    fd.set("image", values.image);
    fd.set("diskSize", values.diskSize.trim() || "10Gi");
    if (values.storageClass) fd.set("storageClass", values.storageClass);
    fd.set("sizeMode", values.sizeMode);
    if (values.sizeMode === "instancetype") {
      fd.set("instanceType", values.instanceType);
    } else {
      fd.set("cpuCores", String(values.cpuCores));
      fd.set("memory", values.memory);
    }
    fd.set("sshKeyMode", values.sshKeyMode);
    if (values.sshKeyMode === "saved") {
      fd.set("savedSshKeyId", values.savedSshKeyId);
    } else {
      fd.set("sshPublicKey", values.sshPublicKey.trim());
    }
    submit(fd, { method: "post" });
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Create router"
        description="Shared OpenStack-style router: claims each VPC’s gateway IP and runs DHCP/DNS for guests. Optional external Multus enables SNAT and floating IPs. Attach more VPCs later via Multus hotplug (no recreate)."
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Create failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      {catalogError && (
        <Alert color="red" variant="light" title="Catalog unavailable">
          {catalogError}
        </Alert>
      )}

      {!preNamespace && (
        <Alert color="blue" variant="light" title="Namespace">
          Pick a vm-allowed namespace that already has a VPC with a private CIDR. Prefer
          opening Create router from a VPC detail page so the VPC is pre-selected.
        </Alert>
      )}

      {preVpcBlockedReason && (
        <Alert color="yellow" variant="light" title={`Cannot attach ${preVpc}`}>
          {preVpcBlockedReason}
        </Alert>
      )}

      {form.values.namespace && !attachableLoading && liveAttachable.length === 0 && (
        <Alert color="yellow" variant="light" title="No VPCs in namespace">
          Namespace <Code>{form.values.namespace}</Code> has no kmc VPCs. Create a VPC
          with private IPAM first.
        </Alert>
      )}
      {form.values.namespace &&
        !attachableLoading &&
        liveAttachable.length > 0 &&
        freeVpcs.length === 0 && (
          <Alert color="yellow" variant="light" title="No attachable VPCs">
            Namespace <Code>{form.values.namespace}</Code> has no free VPC with private
            IPAM — each is already on a router or missing a CIDR.
          </Alert>
        )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Identity">
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select
                label="Cluster"
                data={contexts.length ? contexts : clusters.map((c) => c.id)}
                required
                disabled={blocked || Boolean(preCluster)}
                {...form.getInputProps("cluster")}
              />
              <Select
                label="Namespace"
                data={nsOptions}
                required
                searchable
                disabled={blocked || Boolean(preNamespace)}
                {...form.getInputProps("namespace")}
              />
            </SimpleGrid>
            <TextInput
              label="Router name"
              description="Also the appliance VM name"
              required
              disabled={blocked}
              {...form.getInputProps("name")}
            />
            <MultiSelect
              label="VPCs to attach"
              description="Only free VPCs with private IPAM. Router claims each gateway IP. You can attach more later from the router detail page."
              data={vpcSelectData}
              required
              searchable
              disabled={
                blocked ||
                !form.values.namespace ||
                attachableLoading ||
                freeVpcs.length === 0
              }
              nothingFoundMessage={
                attachableLoading
                  ? "Loading VPCs…"
                  : !form.values.namespace
                    ? "Select a namespace first"
                    : "No free VPCs with private IPAM"
              }
              {...form.getInputProps("vpcNames")}
            />
            {publicNetworks.length > 0 && (
              <>
                <Select
                  label="External gateway (optional)"
                  description="Public Multus for SNAT egress and floating IPs. Leave empty for private-only router."
                  data={[
                    { value: "", label: "None (private only)" },
                    ...publicNetworks.map((p) => ({
                      value: p.multusNetwork,
                      label: `${p.multusNetwork} · ${p.cidr}${p.gateway ? ` via ${p.gateway}` : ""}`,
                    })),
                  ]}
                  clearable
                  searchable
                  disabled={blocked}
                  value={
                    form.values.enableExternal ? form.values.externalMultusNetwork : ""
                  }
                  onChange={(v) => {
                    if (v) {
                      form.setFieldValue("enableExternal", true);
                      form.setFieldValue("externalMultusNetwork", v);
                    } else {
                      form.setFieldValue("enableExternal", false);
                      form.setFieldValue("externalMultusNetwork", "");
                    }
                  }}
                />
              </>
            )}
          </FormSection>

          <FormSection title="Image & size">
            <Select
              label="Image"
              data={imageOptions}
              required
              searchable
              disabled={blocked}
              {...form.getInputProps("image")}
            />
            {hasInstanceTypes && (
              <Select
                label="Instance type"
                data={instanceTypeOptions}
                searchable
                clearable
                disabled={blocked}
                value={
                  form.values.sizeMode === "instancetype"
                    ? form.values.instanceType
                    : null
                }
                onChange={(v) => {
                  if (v) {
                    form.setFieldValue("sizeMode", "instancetype");
                    form.setFieldValue("instanceType", v);
                  } else {
                    form.setFieldValue("sizeMode", "manual");
                    form.setFieldValue("instanceType", "");
                  }
                }}
              />
            )}
            {form.values.sizeMode === "manual" && (
              <SimpleGrid cols={2}>
                <NumberInput
                  label="CPU cores"
                  min={1}
                  disabled={blocked}
                  {...form.getInputProps("cpuCores")}
                />
                <TextInput
                  label="Memory"
                  placeholder="1Gi"
                  disabled={blocked}
                  {...form.getInputProps("memory")}
                />
              </SimpleGrid>
            )}
            <SimpleGrid cols={2}>
              <TextInput
                label="Disk size"
                disabled={blocked}
                {...form.getInputProps("diskSize")}
              />
              <TextInput
                label="Storage class"
                disabled={blocked}
                {...form.getInputProps("storageClass")}
              />
            </SimpleGrid>
          </FormSection>

          <FormSection title="SSH">
            {signedIn && sshKeys.length > 0 && (
              <Select
                label="Saved key"
                data={sshKeys.map((k) => ({
                  value: k.id,
                  label: `${k.name} (${k.fingerprint})`,
                }))}
                clearable
                value={
                  form.values.sshKeyMode === "saved" ? form.values.savedSshKeyId : null
                }
                onChange={(v) => {
                  if (v) {
                    form.setFieldValue("sshKeyMode", "saved");
                    form.setFieldValue("savedSshKeyId", v);
                  } else {
                    form.setFieldValue("sshKeyMode", "paste");
                    form.setFieldValue("savedSshKeyId", "");
                  }
                }}
              />
            )}
            {sshKeysError && (
              <Text size="xs" c="orange">
                {sshKeysError}
              </Text>
            )}
            {(form.values.sshKeyMode === "paste" ||
              !signedIn ||
              sshKeys.length === 0) && (
              <Textarea
                label="SSH public key"
                minRows={3}
                required
                disabled={blocked}
                {...form.getInputProps("sshPublicKey")}
              />
            )}
          </FormSection>

          <FormActions>
            <Button component={Link} to="/routers" variant="default">
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={blocked}>
              Create router
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
