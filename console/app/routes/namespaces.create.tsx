import { Alert, Button, Select, Stack, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect } from "react";
import { Link, redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/namespaces.create";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { logServerError } from "~/lib/errors";
import { namespacePath, validateDns1123Label } from "~/lib/format";
import { VM_ALLOWED_LABEL } from "~/lib/k8s/constants";
import { createNamespace } from "~/namespaces/namespaces.server";
import {
  DEFAULT_QUOTA_FORM,
  NamespaceQuotaFormFields,
  quotaLimitsFromForm,
  validateQuotaFormFields,
  type NamespaceQuotaFormValues,
} from "~/namespaces/quota-form-fields";
import { listClusters } from "~/vms/vms.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Create Namespace · kmc" }];
}

export async function loader() {
  return { clusters: await listClusters() };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const cluster = String(form.get("cluster") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const enableQuota = String(form.get("enableQuota") ?? "") === "true";

  try {
    const quota = enableQuota
      ? {
          cpu: String(form.get("cpu") ?? "").trim() || undefined,
          memory: String(form.get("memory") ?? "").trim() || undefined,
          storage: String(form.get("storage") ?? "").trim() || undefined,
          vms: (() => {
            const raw = String(form.get("vms") ?? "").trim();
            return raw === "" ? undefined : Number(raw);
          })(),
          pvcs: (() => {
            const raw = String(form.get("pvcs") ?? "").trim();
            return raw === "" ? undefined : Number(raw);
          })(),
        }
      : undefined;

    const created = await createNamespace({ cluster, name, quota });
    return redirect(namespacePath(created));
  } catch (err) {
    return {
      error: logServerError("namespace.create", err, { cluster, name }),
    };
  }
}

type CreateFormValues = {
  cluster: string;
  name: string;
} & NamespaceQuotaFormValues;

export default function CreateNamespacePage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { clusters } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";

  const reachable = clusters.filter((c) => c.reachable);

  const form = useForm<CreateFormValues>({
    initialValues: {
      cluster: reachable[0]?.id ?? "",
      name: "",
      ...DEFAULT_QUOTA_FORM,
    },
    validate: (values) => {
      const errors: Partial<Record<keyof CreateFormValues, string>> = {
        ...validateQuotaFormFields(values),
      };
      if (!values.cluster) errors.cluster = "Required";
      const nameErr = validateDns1123Label(values.name);
      if (nameErr) errors.name = nameErr;
      return errors;
    },
  });

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Create failed", actionData.error);
    }
  }, [actionData]);

  const onSubmit = form.onSubmit((values) => {
    const fd = new FormData();
    fd.set("cluster", values.cluster);
    fd.set("name", values.name);
    fd.set("enableQuota", values.enableQuota ? "true" : "false");
    if (values.enableQuota) {
      const limits = quotaLimitsFromForm(values);
      if (limits.cpu) fd.set("cpu", limits.cpu);
      if (limits.memory) fd.set("memory", limits.memory);
      if (limits.storage) fd.set("storage", limits.storage);
      if (limits.vms != null) fd.set("vms", String(limits.vms));
      if (limits.pvcs != null) fd.set("pvcs", String(limits.pvcs));
    }
    submit(fd, { method: "post" });
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Create namespace"
        description="Kubernetes Namespace labeled for VM / VPC / DataVolume workloads"
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Create failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      {reachable.length === 0 && (
        <Alert color="yellow" variant="light" title="No reachable clusters">
          Fix cluster connectivity before creating a namespace.
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Placement">
            <Select
              label="Cluster"
              placeholder="Select cluster"
              data={reachable.map((c) => c.id)}
              required
              value={form.values.cluster}
              error={form.errors.cluster}
              onChange={(v) => form.setFieldValue("cluster", v ?? "")}
            />
          </FormSection>

          <FormSection title="Identity">
            <TextInput
              label="Name"
              placeholder="my-project"
              description="DNS-1123 label (lowercase alphanumeric and hyphens)"
              required
              {...form.getInputProps("name")}
            />
            <Text size="sm" c="dimmed">
              On create, kmc sets{" "}
              <Text span ff="monospace" size="sm">
                {VM_ALLOWED_LABEL}=true
              </Text>{" "}
              so the namespace appears in VM / VPC create pickers.
            </Text>
          </FormSection>

          <FormSection title="Quotas">
            <NamespaceQuotaFormFields
              form={form}
              description="Optional project capacity limits (ResourceQuota). You can also set these later from the namespace detail page."
            />
          </FormSection>

          <FormActions>
            <Button component={Link} to="/namespaces" variant="default">
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={reachable.length === 0}>
              Create Namespace
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
