import { Alert, Button, Select, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import { Link, redirect, useFetcher, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/datavolumes.create";
import { notifyActionError } from "~/lib/action-feedback";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { logServerError } from "~/lib/errors";
import { dataVolumePath, validateDns1123Label } from "~/lib/format";
import { createDataVolume } from "~/datavolumes/datavolumes.server";
import { listClusters } from "~/vms/vms.server";
import type { ClusterCatalog, CreateDataVolumeRequest } from "~/lib/types";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Create DataVolume · kmc" }];
}

export async function loader() {
  return { clusters: await listClusters() };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const size = String(form.get("size") ?? "").trim();
  const storageClass = String(form.get("storageClass") ?? "").trim() || undefined;
  const volumeMode = String(form.get("volumeMode") ?? "Block") as "Block" | "Filesystem";
  const sourceKind = String(form.get("sourceKind") ?? "blank") as
    "blank" | "pvc" | "http";
  const pvcNamespace = String(form.get("pvcNamespace") ?? "").trim() || undefined;
  const pvcName = String(form.get("pvcName") ?? "").trim() || undefined;
  const url = String(form.get("url") ?? "").trim() || undefined;

  const payload: CreateDataVolumeRequest = {
    cluster,
    namespace,
    name,
    size,
    storageClass,
    volumeMode,
    source: {
      kind: sourceKind,
      pvcNamespace,
      pvcName,
      url,
    },
  };

  try {
    await createDataVolume(payload);
    return redirect(dataVolumePath(payload));
  } catch (err) {
    return {
      error: logServerError("datavolume.create", err, {
        cluster,
        namespace,
        name,
      }),
    };
  }
}

export default function CreateDataVolumePage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { clusters } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const catalogFetcher = useFetcher<ClusterCatalog>();
  const submitting = navigation.state === "submitting";

  const form = useForm({
    initialValues: {
      cluster: "",
      namespace: "",
      name: "",
      size: "100Gi",
      storageClass: "",
      volumeMode: "Block" as "Block" | "Filesystem",
      sourceKind: "pvc" as "blank" | "pvc" | "http",
      pvcNamespace: "vm-images",
      pvcName: "",
      url: "",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      namespace: (v) => (!v ? "Required" : null),
      name: validateDns1123Label,
      size: (v) => (!v ? "Required" : null),
      pvcName: (v, values) => (values.sourceKind === "pvc" && !v ? "Required" : null),
      url: (v, values) => (values.sourceKind === "http" && !v ? "Required" : null),
    },
  });

  useEffect(() => {
    if (!form.values.cluster) return;
    catalogFetcher.load(`/api/catalog/${form.values.cluster}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.cluster]);

  useEffect(() => {
    const catalog = catalogFetcher.data;
    if (!catalog) return;
    if (!form.values.storageClass && catalog.defaultStorageClass) {
      form.setFieldValue("storageClass", catalog.defaultStorageClass);
    }
    if (form.values.sourceKind === "pvc" && !form.values.pvcName && catalog.images[0]) {
      form.setFieldValue("pvcNamespace", catalog.images[0].namespace);
      form.setFieldValue("pvcName", catalog.images[0].name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogFetcher.data]);

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Create failed", actionData.error);
    }
  }, [actionData]);

  const catalog = catalogFetcher.data;
  const namespaceOptions = useMemo(
    () => (catalog?.namespaces ?? []).map((n) => n.name),
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
  const imageOptions = useMemo(
    () =>
      (catalog?.images ?? []).map((img) => ({
        value: `${img.namespace}/${img.name}`,
        label: `${img.name}${img.capacity ? ` (${img.capacity})` : ""}`,
      })),
    [catalog],
  );

  const onSubmit = form.onSubmit((values) => {
    submit(
      {
        cluster: values.cluster,
        namespace: values.namespace,
        name: values.name,
        size: values.size,
        storageClass: values.storageClass,
        volumeMode: values.volumeMode,
        sourceKind: values.sourceKind,
        pvcNamespace: values.pvcNamespace,
        pvcName: values.pvcName,
        url: values.url,
      },
      { method: "post" },
    );
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Create data volume"
        description="Provision a CDI DataVolume (blank, PVC clone, or HTTP import)"
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Create failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Placement">
            <Select
              label="Cluster"
              placeholder="Select cluster"
              data={clusters.filter((c) => c.reachable).map((c) => c.id)}
              required
              value={form.values.cluster}
              error={form.errors.cluster}
              onChange={(v) => {
                form.setFieldValue("cluster", v ?? "");
                form.setFieldValue("namespace", "");
                form.setFieldValue("storageClass", "");
                form.setFieldValue("pvcName", "");
              }}
            />
            <Select
              label="Namespace"
              placeholder="Select namespace"
              data={namespaceOptions}
              required
              searchable
              disabled={!form.values.cluster}
              value={form.values.namespace || null}
              error={form.errors.namespace}
              onChange={(v) => form.setFieldValue("namespace", v ?? "")}
            />
          </FormSection>

          <FormSection title="Identity">
            <TextInput
              label="Name"
              placeholder="my-disk"
              required
              {...form.getInputProps("name")}
            />
          </FormSection>

          <FormSection title="Storage">
            <TextInput
              label="Size"
              placeholder="100Gi"
              required
              {...form.getInputProps("size")}
            />
            <Select
              label="Storage class"
              data={storageOptions}
              clearable
              value={form.values.storageClass || null}
              onChange={(v) => form.setFieldValue("storageClass", v ?? "")}
            />
            <Select
              label="Volume mode"
              data={["Block", "Filesystem"]}
              value={form.values.volumeMode}
              onChange={(v) =>
                form.setFieldValue("volumeMode", (v as "Block" | "Filesystem") ?? "Block")
              }
            />
          </FormSection>

          <FormSection title="Source">
            <Select
              label="Source type"
              data={[
                { value: "pvc", label: "PVC clone" },
                { value: "blank", label: "Blank" },
                { value: "http", label: "HTTP import" },
              ]}
              value={form.values.sourceKind}
              onChange={(v) =>
                form.setFieldValue(
                  "sourceKind",
                  (v as "blank" | "pvc" | "http") ?? "blank",
                )
              }
            />
            {form.values.sourceKind === "pvc" && (
              <Select
                label="Source image PVC"
                data={imageOptions}
                searchable
                required
                value={
                  form.values.pvcName
                    ? `${form.values.pvcNamespace}/${form.values.pvcName}`
                    : null
                }
                error={form.errors.pvcName}
                onChange={(v) => {
                  if (!v) {
                    form.setFieldValue("pvcName", "");
                    return;
                  }
                  const [ns, ...rest] = v.split("/");
                  form.setFieldValue("pvcNamespace", ns);
                  form.setFieldValue("pvcName", rest.join("/"));
                }}
              />
            )}
            {form.values.sourceKind === "http" && (
              <TextInput
                label="Image URL"
                placeholder="https://…"
                required
                {...form.getInputProps("url")}
              />
            )}
          </FormSection>

          <FormActions>
            <Button component={Link} to="/datavolumes" variant="default">
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Create DataVolume
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
