import { Alert, Button, NumberInput, Select, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect } from "react";
import { Link, redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/instancetypes.create";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { logServerError } from "~/lib/errors";
import { instanceTypePath, validateDns1123Label } from "~/lib/format";
import { createClusterInstanceType } from "~/instancetypes/instancetypes.server";
import { listClusters } from "~/vms/vms.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Create Instance Type · kmc" }];
}

export async function loader() {
  return { clusters: await listClusters() };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const cluster = String(form.get("cluster") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const cpu = Number(form.get("cpu") ?? 1);
  const memory = String(form.get("memory") ?? "").trim();

  try {
    await createClusterInstanceType({ cluster, name, cpu, memory });
    return redirect(instanceTypePath({ cluster, name }));
  } catch (err) {
    return {
      error: logServerError("instancetype.create", err, { cluster, name }),
    };
  }
}

export default function CreateInstanceTypePage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { clusters } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";

  const form = useForm({
    initialValues: {
      cluster: "",
      name: "",
      cpu: 1,
      memory: "4Gi",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      name: validateDns1123Label,
      cpu: (v) => (v < 1 ? "Min 1" : null),
      memory: (v) => (!v ? "Required" : null),
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
        cpu: String(values.cpu),
        memory: values.memory,
      },
      { method: "post" },
    );
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Create instance type"
        description="VirtualMachineClusterInstancetype — cluster-scoped CPU/memory size"
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
              onChange={(v) => form.setFieldValue("cluster", v ?? "")}
            />
          </FormSection>

          <FormSection title="Identity">
            <TextInput
              label="Name"
              placeholder="u1.custom"
              description="DNS-1123 label, e.g. u1.medium"
              required
              {...form.getInputProps("name")}
            />
          </FormSection>

          <FormSection title="Resources">
            <NumberInput
              label="CPU (guest cores)"
              min={1}
              max={256}
              required
              {...form.getInputProps("cpu")}
            />
            <TextInput
              label="Memory"
              placeholder="4Gi"
              required
              {...form.getInputProps("memory")}
            />
          </FormSection>

          <FormActions>
            <Button component={Link} to="/instancetypes" variant="default">
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Create Instance Type
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
