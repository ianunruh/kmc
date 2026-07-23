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

  try {
    const created = await createNamespace({ cluster, name });
    return redirect(namespacePath(created));
  } catch (err) {
    return {
      error: logServerError("namespace.create", err, { cluster, name }),
    };
  }
}

export default function CreateNamespacePage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { clusters } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";

  const reachable = clusters.filter((c) => c.reachable);

  const form = useForm({
    initialValues: {
      cluster: reachable[0]?.id ?? "",
      name: "",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      name: validateDns1123Label,
    },
  });

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Create failed", actionData.error);
    }
  }, [actionData]);

  const onSubmit = form.onSubmit((values) => {
    submit(
      {
        cluster: values.cluster,
        name: values.name,
      },
      { method: "post" },
    );
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
