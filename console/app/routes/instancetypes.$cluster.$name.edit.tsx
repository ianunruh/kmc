import { Alert, Button, NumberInput, Stack, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect } from "react";
import { Link, redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/instancetypes.$cluster.$name.edit";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { logServerError } from "~/lib/errors";
import { instanceTypePath } from "~/lib/format";
import {
  getClusterInstanceType,
  updateClusterInstanceType,
} from "~/instancetypes/instancetypes.server";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Edit ${params.name ?? "instance type"} · kmc` }];
}

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, name } = params;
  if (!cluster || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const it = await getClusterInstanceType(cluster, name);
  if (it.builtin) {
    // Operator / common-instancetypes types are immutable via kmc.
    throw redirect(instanceTypePath({ cluster, name }));
  }
  return { it };
});

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, name } = params;
  if (!cluster || !name) {
    return { error: "Missing path params" };
  }
  const form = await request.formData();
  const cpu = Number(form.get("cpu") ?? 1);
  const memory = String(form.get("memory") ?? "").trim();

  try {
    await updateClusterInstanceType({ cluster, name, cpu, memory });
    return redirect(instanceTypePath({ cluster, name }));
  } catch (err) {
    return {
      error: logServerError("instancetype.update", err, { cluster, name }),
    };
  }
}

export default function EditInstanceTypePage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { it } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";

  const form = useForm({
    initialValues: {
      cpu: it.cpu,
      memory: it.memory,
    },
    validate: {
      cpu: (v) => (v < 1 ? "Min 1" : null),
      memory: (v) => (!v ? "Required" : null),
    },
  });

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Update failed", actionData.error);
    }
  }, [actionData]);

  const onSubmit = form.onSubmit((values) => {
    submit({ cpu: String(values.cpu), memory: values.memory }, { method: "post" });
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title={`Edit ${it.name}`}
        description={
          <Text span size="sm" c="dimmed">
            {it.cluster} · name is immutable
          </Text>
        }
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Update failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Identity">
            <TextInput label="Cluster" value={it.cluster} disabled />
            <TextInput label="Name" value={it.name} disabled />
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
            <Button component={Link} to={instanceTypePath(it)} variant="default">
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Save changes
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
