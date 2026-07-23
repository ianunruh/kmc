import {
  Alert,
  Button,
  Code,
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
import { Link, redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/vpcs.$cluster.$namespace.$name.nat-gateway";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { getRequestSession } from "~/lib/auth/middleware.server";
import { logServerError } from "~/lib/errors";
import { vpcPath } from "~/lib/format";
import { getClusterCatalog } from "~/lib/k8s/catalog.server";
import { listSshKeysOrEmpty } from "~/ssh-keys/ssh-keys.server";
import {
  createNatGateway,
  defaultGatewayAddress,
  getVpc,
  listPublicEgressNetworks,
} from "~/vpcs/vpcs.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Add NAT gateway · ${params.name ?? "VPC"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  const vpc = await getVpc(cluster, namespace, name);

  if (!vpc.cidr?.trim()) {
    throw new Response(
      "NAT gateway requires private IPAM on the VPC (set a CIDR first)",
      { status: 400 },
    );
  }
  if (vpc.natGateway) {
    throw redirect(vpcPath(vpc));
  }

  const publicNetworks = listPublicEgressNetworks(cluster, {
    excludeMultus: name,
  });

  let catalog: Awaited<ReturnType<typeof getClusterCatalog>> | null = null;
  let catalogError: string | null = null;
  try {
    catalog = await getClusterCatalog(cluster);
  } catch (err) {
    catalogError = err instanceof Error ? err.message : String(err);
  }

  const session = getRequestSession();
  const { keys: sshKeys, error: sshKeysError } = await listSshKeysOrEmpty(
    session?.user ?? null,
  );

  const suggestedGateway = vpc.gateway?.trim() || defaultGatewayAddress(vpc.cidr);

  return {
    vpc,
    publicNetworks,
    catalog,
    catalogError,
    suggestedGateway,
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

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { error: "Missing path params" };
  }

  const form = await request.formData();
  const vmName = String(form.get("name") ?? "").trim();
  const publicMultusNetwork = String(form.get("publicMultusNetwork") ?? "").trim();
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

  if (!vmName) return { error: "Name is required" };
  if (!publicMultusNetwork) {
    return { error: "Public / egress network is required" };
  }
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
    const payload = {
      cluster,
      namespace,
      vpcName: name,
      name: vmName,
      publicMultusNetwork,
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
      await createNatGateway({ ...payload, instanceType });
    } else {
      const cpuCores = Number(cpuCoresRaw || 1);
      if (!Number.isFinite(cpuCores) || cpuCores < 1) {
        return { error: "CPU cores must be a positive number" };
      }
      if (!memory) return { error: "Memory is required" };
      await createNatGateway({
        ...payload,
        cpuCores,
        memory,
      });
    }

    return redirect(vpcPath({ cluster, namespace, name }));
  } catch (err) {
    return {
      error: logServerError("vpc.createNatGateway", err, {
        cluster,
        namespace,
        name,
        vmName,
      }),
    };
  }
}

export default function AddNatGatewayPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    vpc,
    publicNetworks,
    catalog,
    catalogError,
    suggestedGateway,
    sshKeys,
    sshKeysError,
    signedIn,
  } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("NAT gateway failed", actionData.error);
    }
  }, [actionData]);

  const imageOptions = useMemo(() => {
    if (!catalog) return [];
    return catalog.images.map((img) => ({
      value: `${img.namespace}/${img.name}`,
      label: `${img.name}${img.capacity ? ` (${img.capacity})` : ""}`,
    }));
  }, [catalog]);

  const publicNetOptions = useMemo(
    () =>
      publicNetworks.map((p) => ({
        value: p.multusNetwork,
        label: `${p.multusNetwork} · ${p.cidr}${p.gateway ? ` via ${p.gateway}` : ""}`,
      })),
    [publicNetworks],
  );

  const instanceTypeOptions = useMemo(() => {
    if (!catalog) return [];
    return catalog.instanceTypes.map((it) => ({
      value: it.name,
      label: `${it.name}${it.cpu || it.memory ? ` (${[it.cpu, it.memory].filter(Boolean).join(" / ")})` : ""}`,
    }));
  }, [catalog]);

  const defaultImage =
    imageOptions.find((o) => o.value.includes("ubuntu"))?.value ??
    imageOptions[0]?.value ??
    "";

  const form = useForm({
    initialValues: {
      name: `${vpc.name}-nat`.slice(0, 63),
      publicMultusNetwork: publicNetOptions[0]?.value ?? "",
      image: defaultImage,
      sizeMode: (instanceTypeOptions.length > 0 ? "instancetype" : "manual") as
        "instancetype" | "manual",
      instanceType: instanceTypeOptions[0]?.value ?? "",
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
      name: (v) =>
        !v.trim()
          ? "Required"
          : !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v.trim())
            ? "DNS-1123 label"
            : null,
      publicMultusNetwork: (v) => (!v ? "Required" : null),
      image: (v) => (!v ? "Required" : null),
      sshPublicKey: (v, values) =>
        values.sshKeyMode === "paste" && !v.trim() ? "Required" : null,
      savedSshKeyId: (v, values) =>
        values.sshKeyMode === "saved" && !v ? "Select a key" : null,
    },
  });

  const onSubmit = form.onSubmit((values) => {
    const fd = new FormData();
    fd.set("name", values.name.trim());
    fd.set("publicMultusNetwork", values.publicMultusNetwork);
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

  const blocked = publicNetworks.length === 0 || Boolean(catalogError) || !catalog;

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Add NAT gateway"
        description={
          <Text span size="sm" c="dimmed">
            {vpc.cluster}/{vpc.namespace}/{vpc.name} · dual-homed Ubuntu VM for VPC egress
            + floating IPs (pod NIC agent, SNAT/DNAT)
          </Text>
        }
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Launch failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      {publicNetworks.length === 0 && (
        <Alert color="yellow" variant="light" title="No egress networks">
          No public Multus networks with <Code>ipPools</Code> are configured on this
          cluster. Add an egress pool (e.g. <Code>external</Code>) in{" "}
          <Code>clusters.yaml</Code>.
        </Alert>
      )}

      {catalogError && (
        <Alert color="red" variant="light" title="Catalog unavailable">
          {catalogError}
        </Alert>
      )}

      <Alert color="gray" variant="light">
        Private NIC is pinned to <Code>{suggestedGateway}</Code>
        {vpc.gateway ? "" : " (written as the VPC gateway if not already set)"}. Public
        Multus handles the default route and SNAT. A third <Code>pod</Code> NIC reaches
        the apiserver so the in-guest agent can watch the policy ConfigMap (requires
        cluster <Code>network.podCIDR</Code> / <Code>serviceCIDR</Code>).
      </Alert>

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Identity">
            <TextInput
              label="VM name"
              required
              disabled={blocked}
              {...form.getInputProps("name")}
            />
          </FormSection>

          <FormSection title="Networks">
            <Select
              label="Public / egress network"
              description="Static Multus network with an ipPools entry (north-south path)."
              data={publicNetOptions}
              required
              searchable
              disabled={blocked}
              {...form.getInputProps("publicMultusNetwork")}
            />
            <Text size="xs" c="dimmed">
              Private attachment is fixed to this VPC (
              <Code>
                {vpc.namespace}/{vpc.name}
              </Code>
              ).
            </Text>
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

            {instanceTypeOptions.length > 0 && (
              <Select
                label="Size mode"
                data={[
                  { value: "instancetype", label: "Instance type" },
                  { value: "manual", label: "Manual CPU / memory" },
                ]}
                disabled={blocked}
                {...form.getInputProps("sizeMode")}
              />
            )}

            {form.values.sizeMode === "instancetype" && instanceTypeOptions.length > 0 ? (
              <Select
                label="Instance type"
                data={instanceTypeOptions}
                searchable
                disabled={blocked}
                {...form.getInputProps("instanceType")}
              />
            ) : (
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
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

            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <TextInput
                label="Disk size"
                placeholder="10Gi"
                disabled={blocked}
                {...form.getInputProps("diskSize")}
              />
              <Select
                label="Storage class"
                clearable
                disabled={blocked}
                data={
                  catalog?.storageClasses.map((sc) => ({
                    value: sc.name,
                    label: sc.isDefault ? `${sc.name} (default)` : sc.name,
                  })) ?? []
                }
                {...form.getInputProps("storageClass")}
              />
            </SimpleGrid>
          </FormSection>

          <FormSection title="Access">
            {sshKeysError && (
              <Alert color="yellow" variant="light">
                Could not load saved SSH keys: {sshKeysError}
              </Alert>
            )}

            {signedIn && sshKeys.length > 0 && (
              <Select
                label="SSH key source"
                data={[
                  { value: "saved", label: "Saved key" },
                  { value: "paste", label: "Paste public key" },
                ]}
                disabled={blocked}
                {...form.getInputProps("sshKeyMode")}
              />
            )}

            {form.values.sshKeyMode === "saved" && sshKeys.length > 0 ? (
              <Select
                label="SSH key"
                data={sshKeys.map((k) => ({
                  value: k.id,
                  label: `${k.name} (${k.fingerprint})`,
                }))}
                required
                disabled={blocked}
                {...form.getInputProps("savedSshKeyId")}
              />
            ) : (
              <Textarea
                label="SSH public key"
                required
                minRows={3}
                autosize
                disabled={blocked}
                styles={{
                  input: {
                    fontFamily: "var(--mantine-font-family-monospace)",
                  },
                }}
                {...form.getInputProps("sshPublicKey")}
              />
            )}
          </FormSection>

          <FormActions>
            <Button
              component={Link}
              to={vpcPath(vpc)}
              variant="default"
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" color="teal" loading={submitting} disabled={blocked}>
              Launch NAT gateway
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
