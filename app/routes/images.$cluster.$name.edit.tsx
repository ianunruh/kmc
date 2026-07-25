import { Alert, Button, Select, Stack, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import { Link, redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/images.$cluster.$name.edit";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { logServerError } from "~/lib/errors";
import { imagePath } from "~/lib/format";
import { getImage, updateImagePreference } from "~/images/images.server";
import { getClusterCatalog } from "~/lib/k8s/catalog.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Edit ${params.name ?? "image"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, name } = params;
  if (!cluster || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const [image, catalog] = await Promise.all([
    getImage(cluster, name),
    getClusterCatalog(cluster).catch(() => null),
  ]);
  return {
    image,
    preferences: catalog?.preferences.map((p) => p.name) ?? [],
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, name } = params;
  if (!cluster || !name) {
    return { error: "Missing path params" };
  }
  const form = await request.formData();
  const preferenceRaw = String(form.get("preference") ?? "").trim();
  const preference = preferenceRaw || null;

  try {
    await updateImagePreference(cluster, name, preference);
    return redirect(imagePath({ cluster, name }));
  } catch (err) {
    return {
      error: logServerError("image.update", err, { cluster, name }),
    };
  }
}

export default function EditImagePage({ loaderData, actionData }: Route.ComponentProps) {
  const { image, preferences } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";

  const form = useForm({
    initialValues: {
      preference: image.preference ?? "",
    },
  });

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Update failed", actionData.error);
    }
  }, [actionData]);

  const preferenceOptions = useMemo(() => {
    const current = form.values.preference.trim();
    if (current && !preferences.includes(current)) {
      return [current, ...preferences];
    }
    return preferences;
  }, [preferences, form.values.preference]);

  const onSubmit = form.onSubmit((values) => {
    submit({ preference: values.preference }, { method: "post" });
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title={`Edit ${image.name}`}
        description={
          <Text span size="sm" c="dimmed">
            {image.cluster} / {image.namespace} · set cluster preference for Launch VM
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
            <TextInput label="Cluster" value={image.cluster} disabled />
            <TextInput label="Namespace" value={image.namespace} disabled />
            <TextInput label="Name" value={image.name} disabled />
          </FormSection>

          <FormSection title="Cluster preference">
            <Text size="sm" c="dimmed">
              Label{" "}
              <Text span ff="monospace" size="xs">
                kmc.ianunruh.com/cluster-preference
              </Text>{" "}
              on the PVC (and DataVolume when present). Launch VM applies this as the
              guest{" "}
              <Text span ff="monospace" size="xs">
                VirtualMachineClusterPreference
              </Text>
              . Clear the field to remove the label.
            </Text>
            <Select
              label="Preference"
              description="Optional VirtualMachineClusterPreference name"
              placeholder="None"
              data={preferenceOptions}
              clearable
              searchable
              {...form.getInputProps("preference")}
              value={form.values.preference || null}
              onChange={(v) => form.setFieldValue("preference", v ?? "")}
            />
          </FormSection>

          <FormActions>
            <Button
              component={Link}
              to={imagePath(image)}
              variant="default"
              disabled={submitting}
            >
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
