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
import type { Route } from "./+types/databases.create";
import { notifyActionError } from "~/lib/action-feedback";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { logServerError } from "~/lib/errors";
import {
  databasePath,
  validateDns1123Label,
} from "~/lib/format";
import { getSearchParam } from "~/lib/search-params";
import { createDatabase } from "~/databases/databases.server";
import {
  DATABASE_INSTANCE_OPTIONS,
  DATABASE_POSTGRES_IMAGES,
  DATABASE_SIZE_OPTIONS,
  DATABASE_SIZE_PRESETS,
  DEFAULT_DATABASE_INSTANCES,
  DEFAULT_DATABASE_POSTGRES_VERSION,
  DEFAULT_DATABASE_SIZE,
  isDatabaseSizePreset,
} from "~/databases/options";
import { listClusters } from "~/vms/vms.server";
import type { ClusterCatalog, DatabaseSizePreset } from "~/lib/types";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Create Database · kmc" }];
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
  const sizeRaw = String(form.get("size") ?? "").trim();
  const instancesRaw = String(form.get("instances") ?? "").trim();
  const postgresVersion = String(form.get("postgresVersion") ?? "").trim();
  const storageClass = String(form.get("storageClass") ?? "").trim() || undefined;
  const storageSize = String(form.get("storageSize") ?? "").trim() || undefined;

  try {
    if (!isDatabaseSizePreset(sizeRaw)) {
      throw new Error("size must be small, medium, or large");
    }
    const instances = Number(instancesRaw);
    if (instances !== 1 && instances !== 3) {
      throw new Error("instances must be 1 or 3");
    }

    const created = await createDatabase({
      cluster,
      namespace,
      name,
      size: sizeRaw,
      instances,
      postgresVersion,
      storageClass,
      storageSize,
    });
    return redirect(databasePath(created));
  } catch (err) {
    return {
      error: logServerError("database.create", err, {
        cluster,
        namespace,
        name,
      }),
    };
  }
}

export default function CreateDatabasePage({
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
      size: DEFAULT_DATABASE_SIZE as DatabaseSizePreset,
      instances: String(DEFAULT_DATABASE_INSTANCES),
      postgresVersion: DEFAULT_DATABASE_POSTGRES_VERSION,
      storageClass: "",
      storageSize: "",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      namespace: (v) => (!v ? "Required" : null),
      name: validateDns1123Label,
      size: (v) => (isDatabaseSizePreset(v) ? null : "Required"),
      instances: (v) => (v === "1" || v === "3" ? null : "Choose 1 or 3"),
      postgresVersion: (v) => (!v ? "Required" : null),
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

  const sizePreset = isDatabaseSizePreset(form.values.size)
    ? DATABASE_SIZE_PRESETS[form.values.size]
    : DATABASE_SIZE_PRESETS.small;
  const storagePlaceholder = sizePreset.storageSize;

  const onSubmit = form.onSubmit((values) => {
    submit(
      {
        cluster: values.cluster,
        namespace: values.namespace,
        name: values.name,
        size: values.size,
        instances: values.instances,
        postgresVersion: values.postgresVersion,
        storageClass: values.storageClass,
        storageSize: values.storageSize,
      },
      { method: "post" },
    );
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Create database"
        description="Provision a CloudNativePG PostgreSQL cluster with kmc defaults"
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
              label="Name"
              description="DNS-1123 label — becomes the Cluster name and service prefix"
              placeholder="app-db"
              required
              {...form.getInputProps("name")}
            />
          </FormSection>

          <FormSection title="Capacity">
            <Select
              label="Size"
              description={
                sizePreset
                  ? `Requests ${sizePreset.resources.requests.cpu} CPU / ${sizePreset.resources.requests.memory}, limits ${sizePreset.resources.limits.cpu} / ${sizePreset.resources.limits.memory}`
                  : undefined
              }
              data={DATABASE_SIZE_OPTIONS}
              required
              value={form.values.size}
              error={form.errors.size}
              onChange={(v) => {
                if (v && isDatabaseSizePreset(v)) {
                  form.setFieldValue("size", v);
                }
              }}
            />
            <Select
              label="Instances"
              data={[...DATABASE_INSTANCE_OPTIONS]}
              required
              value={form.values.instances}
              error={form.errors.instances}
              onChange={(v) => form.setFieldValue("instances", v ?? "1")}
            />
            <Select
              label="Postgres version"
              data={DATABASE_POSTGRES_IMAGES.map((img) => ({
                value: img.version,
                label: img.label,
              }))}
              required
              value={form.values.postgresVersion}
              error={form.errors.postgresVersion}
              onChange={(v) => form.setFieldValue("postgresVersion", v ?? "")}
            />
            <Select
              label="Storage class"
              data={storageOptions}
              clearable
              disabled={!form.values.cluster}
              value={form.values.storageClass || null}
              onChange={(v) => form.setFieldValue("storageClass", v ?? "")}
            />
            <TextInput
              label="Storage size"
              description={`Optional override (default ${storagePlaceholder} from size preset)`}
              placeholder={storagePlaceholder}
              value={form.values.storageSize}
              onChange={(e) =>
                form.setFieldValue("storageSize", e.currentTarget.value)
              }
            />
          </FormSection>

          <FormSection title="Defaults">
            <Text size="sm" c="dimmed">
              Creates a CNPG Cluster with superuser access enabled, bootstrap
              database/owner <Text span ff="monospace">app</Text>, and kmc
              ownership labels. After Ready, the detail page shows app and
              superuser connection secrets for copy/paste.
            </Text>
          </FormSection>

          <FormActions>
            <Button component={Link} to="/databases" variant="default">
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Create database
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
