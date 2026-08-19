import { Alert, Button, Select, Stack, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import { Link, redirect, useFetcher, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/images.create";
import { notifyActionError } from "~/lib/action-feedback";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { logServerError } from "~/lib/errors";
import { imagePath, validateDns1123Label } from "~/lib/format";
import { createImage, getImageNamespace } from "~/images/images.server";
import { listClusters } from "~/vms/vms.server";
import type { ClusterCatalog, CreateImageRequest } from "~/lib/types";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Import Image · kmc" }];
}

export const loader = tracedLoader(async () => {
  return {
    clusters: await listClusters(),
    imageNamespace: getImageNamespace(),
  };
});

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const cluster = String(form.get("cluster") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const url = String(form.get("url") ?? "").trim();
  const size = String(form.get("size") ?? "").trim();
  const storageClass = String(form.get("storageClass") ?? "").trim() || undefined;
  const volumeMode = String(form.get("volumeMode") ?? "Block") as "Block" | "Filesystem";
  const preference = String(form.get("preference") ?? "").trim() || undefined;

  const payload: CreateImageRequest = {
    cluster,
    name,
    url,
    size,
    storageClass,
    volumeMode,
    preference,
  };

  try {
    await createImage(payload);
    return redirect(imagePath({ cluster: payload.cluster, name: payload.name }));
  } catch (err) {
    return {
      error: logServerError("image.create", err, { cluster, name }),
    };
  }
}

export default function CreateImagePage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { clusters, imageNamespace } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const catalogFetcher = useFetcher<ClusterCatalog>();
  const submitting = navigation.state === "submitting";

  const form = useForm({
    initialValues: {
      cluster: "",
      name: "",
      url: "",
      size: "10Gi",
      storageClass: "",
      volumeMode: "Block" as "Block" | "Filesystem",
      preference: "",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      name: validateDns1123Label,
      url: (v) => {
        if (!v) return "Required";
        try {
          const u = new URL(v);
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            return "URL must be http or https";
          }
        } catch {
          return "Invalid URL";
        }
        return null;
      },
      size: (v) => (!v ? "Required" : null),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogFetcher.data]);

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Import failed", actionData.error);
    }
  }, [actionData]);

  const catalog = catalogFetcher.data;
  const storageClassOptions = useMemo(
    () =>
      (catalog?.storageClasses ?? []).map((sc) => ({
        value: sc.name,
        label: sc.isDefault ? `${sc.name} (default)` : sc.name,
      })),
    [catalog],
  );
  const preferenceOptions = useMemo(
    () => (catalog?.preferences ?? []).map((p) => p.name),
    [catalog],
  );

  const onSubmit = form.onSubmit((values) => {
    submit(
      {
        cluster: values.cluster,
        name: values.name,
        url: values.url,
        size: values.size,
        storageClass: values.storageClass,
        volumeMode: values.volumeMode,
        preference: values.preference,
      },
      { method: "post" },
    );
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Import image"
        description={`Create a CDI DataVolume in ${imageNamespace} from an HTTP(S) URL. The cluster importer pulls the image — no local upload.`}
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Import failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <Alert color="gray" variant="light" title="Local files">
        For a local disk image (e.g. after curling an Ubuntu cloudimg), keep using{" "}
        <Text span ff="monospace" size="sm">
          virtctl image-upload
        </Text>{" "}
        into {imageNamespace}. This form only supports HTTP(S) import.
      </Alert>

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Placement">
            <Select
              label="Cluster"
              placeholder="Select cluster"
              data={clusters.filter((c) => c.reachable).map((c) => c.id)}
              required
              {...form.getInputProps("cluster")}
            />
            <Text size="xs" c="dimmed">
              Namespace is fixed to{" "}
              <Text span ff="monospace">
                {imageNamespace}
              </Text>{" "}
              ({`KMC_IMAGE_NAMESPACE`}).
            </Text>
          </FormSection>

          <FormSection title="Image">
            <TextInput
              label="Name"
              description="DNS-1123 label for the DataVolume and PVC"
              placeholder="ubuntu-server-resolute-amd64"
              required
              {...form.getInputProps("name")}
            />
            <TextInput
              label="Image URL"
              description="HTTP(S) URL the cluster can reach (cloudimg, qcow2, raw, …)"
              placeholder="https://cloud-images.ubuntu.com/…/…-server-cloudimg-amd64.img"
              required
              {...form.getInputProps("url")}
            />
            <TextInput
              label="Size"
              description="Must be at least as large as the image (Ubuntu cloudimgs often need ≥10Gi)"
              placeholder="10Gi"
              required
              {...form.getInputProps("size")}
            />
            <Select
              label="Storage class"
              placeholder={
                catalogFetcher.state === "loading" ? "Loading…" : "Select storage class"
              }
              data={storageClassOptions}
              clearable
              searchable
              disabled={!form.values.cluster || catalogFetcher.state === "loading"}
              {...form.getInputProps("storageClass")}
            />
            <Select
              label="Volume mode"
              data={[
                { value: "Block", label: "Block" },
                { value: "Filesystem", label: "Filesystem" },
              ]}
              {...form.getInputProps("volumeMode")}
            />
            <Select
              label="Cluster preference"
              description="Optional VirtualMachineClusterPreference applied when launching from this image"
              placeholder="None"
              data={preferenceOptions}
              clearable
              searchable
              disabled={!form.values.cluster}
              {...form.getInputProps("preference")}
            />
          </FormSection>

          <FormActions>
            <Button component={Link} to="/images" variant="default" disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Import
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
