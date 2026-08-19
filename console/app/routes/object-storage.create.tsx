import {
  Alert,
  Button,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import { Link, redirect, useFetcher, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/object-storage.create";
import { notifyActionError } from "~/lib/action-feedback";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { logServerError } from "~/lib/errors";
import {
  objectStoragePath,
  validateDns1123Label,
} from "~/lib/format";
import { getSearchParam } from "~/lib/search-params";
import { createObjectBucket } from "~/object-storage/object-storage.server";
import {
  isObjectBucketStorageClass,
  pickDefaultObjectStorageClass,
} from "~/object-storage/options";
import { listClusters } from "~/vms/vms.server";
import type { ClusterCatalog } from "~/lib/types";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Create Object Bucket · kmc" }];
}

export const loader = tracedLoader(async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);
  return {
    clusters: await listClusters(),
    prefill: {
      cluster: getSearchParam(url.searchParams, "cluster") ?? "",
      namespace: getSearchParam(url.searchParams, "namespace") ?? "",
      name: getSearchParam(url.searchParams, "name") ?? "",
    },
  };
});

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const storageClass = String(form.get("storageClass") ?? "").trim();
  const bucketName = String(form.get("bucketName") ?? "").trim() || undefined;

  try {
    const created = await createObjectBucket({
      cluster,
      namespace,
      name,
      storageClass,
      bucketName,
    });
    return redirect(objectStoragePath(created));
  } catch (err) {
    return {
      error: logServerError("object-storage.create", err, {
        cluster,
        namespace,
        name,
      }),
    };
  }
}

export default function CreateObjectBucketPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { clusters, prefill } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const catalogFetcher = useFetcher<ClusterCatalog>();
  const submitting = navigation.state === "submitting";

  const form = useForm({
    initialValues: {
      cluster: prefill.cluster,
      namespace: prefill.namespace,
      name: prefill.name,
      storageClass: "",
      bucketName: "",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      namespace: (v) => (!v ? "Required" : null),
      name: validateDns1123Label,
      storageClass: (v) => (!v ? "Required" : null),
      bucketName: (v) => {
        if (!v?.trim()) return null;
        if (v.length < 3) return "Min 3 characters";
        if (v.length > 63) return "Max 63 characters";
        if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(v)) {
          return "Lowercase alphanumeric, dots, and hyphens";
        }
        return null;
      },
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
    if (!form.values.storageClass) {
      const def = pickDefaultObjectStorageClass(catalog.storageClasses ?? []);
      if (def) form.setFieldValue("storageClass", def);
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
  const storageOptions = useMemo(() => {
    const buckets = (catalog?.storageClasses ?? []).filter(
      isObjectBucketStorageClass,
    );
    return buckets.map((sc) => ({
      value: sc.name,
      label: sc.isDefault ? `${sc.name} (default)` : sc.name,
    }));
  }, [catalog]);

  const onSubmit = form.onSubmit((values) => {
    submit(
      {
        cluster: values.cluster,
        namespace: values.namespace,
        name: values.name,
        storageClass: values.storageClass,
        bucketName: values.bucketName,
      },
      { method: "post" },
    );
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Create object bucket"
        description="Provision an S3-compatible bucket via ObjectBucketClaim (Rook Ceph RGW)"
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
              value={form.values.cluster || null}
              error={form.errors.cluster}
              onChange={(v) => {
                form.setFieldValue("cluster", v ?? "");
                form.setFieldValue("namespace", "");
                form.setFieldValue("storageClass", "");
              }}
            />
            <Select
              label="Namespace"
              description="vm-allowed namespaces only (same as Launch VM)"
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
              label="Claim name"
              description="DNS-1123 label — ObjectBucketClaim name; also used as generateBucketName prefix when bucket name is empty"
              placeholder="app-assets"
              required
              {...form.getInputProps("name")}
            />
            <TextInput
              label="Bucket name"
              description="Optional exact S3 bucket name. Leave empty to let the provisioner generate a unique name from the claim name."
              placeholder="(auto-generate)"
              {...form.getInputProps("bucketName")}
            />
          </FormSection>

          <FormSection title="Storage">
            <Select
              label="Storage class"
              description="Object-bucket StorageClasses only (Rook Ceph RGW provisioner)"
              data={storageOptions}
              required
              disabled={!form.values.cluster}
              value={form.values.storageClass || null}
              error={form.errors.storageClass}
              onChange={(v) => form.setFieldValue("storageClass", v ?? "")}
              nothingFoundMessage={
                form.values.cluster
                  ? "No object-bucket StorageClasses on this cluster"
                  : "Select a cluster first"
              }
            />
          </FormSection>

          <FormSection title="Defaults">
            <Text size="sm" c="dimmed">
              Creates an ObjectBucketClaim with kmc ownership labels. When Bound,
              a ConfigMap and Secret with the same name hold the S3 endpoint and
              AWS-style access keys for in-cluster apps.
            </Text>
          </FormSection>

          <FormActions>
            <Button component={Link} to="/object-storage" variant="default">
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Create bucket
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
