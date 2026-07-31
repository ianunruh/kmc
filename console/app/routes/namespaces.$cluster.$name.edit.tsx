import { Alert, Button, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect } from "react";
import { Link, redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/namespaces.$cluster.$name.edit";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { logServerError } from "~/lib/errors";
import { namespacePath } from "~/lib/format";
import {
  deleteNamespaceQuota,
  getNamespace,
  upsertNamespaceQuota,
} from "~/namespaces/namespaces.server";
import {
  DEFAULT_QUOTA_FORM,
  NamespaceQuotaFormFields,
  quotaLimitsFromForm,
  validateQuotaFormFields,
  type NamespaceQuotaFormValues,
} from "~/namespaces/quota-form-fields";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Edit quotas · ${params.name ?? "Namespace"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, name } = params;
  if (!cluster || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const ns = await getNamespace(cluster, name);
  return { ns };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, name } = params;
  if (!cluster || !name) {
    return { error: "Missing path params" };
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");

  try {
    if (intent === "clear") {
      await deleteNamespaceQuota(cluster, name);
      return redirect(namespacePath({ cluster, name }));
    }

    const enableQuota = String(form.get("enableQuota") ?? "") === "true";
    if (!enableQuota) {
      await deleteNamespaceQuota(cluster, name);
      return redirect(namespacePath({ cluster, name }));
    }

    const vmsRaw = String(form.get("vms") ?? "").trim();
    const pvcsRaw = String(form.get("pvcs") ?? "").trim();
    await upsertNamespaceQuota({
      cluster,
      name,
      quota: {
        cpu: String(form.get("cpu") ?? "").trim() || undefined,
        memory: String(form.get("memory") ?? "").trim() || undefined,
        storage: String(form.get("storage") ?? "").trim() || undefined,
        vms: vmsRaw === "" ? undefined : Number(vmsRaw),
        pvcs: pvcsRaw === "" ? undefined : Number(pvcsRaw),
      },
    });
    return redirect(namespacePath({ cluster, name }));
  } catch (err) {
    return {
      error: logServerError("namespace.quota", err, { cluster, name, intent }),
    };
  }
}

export default function EditNamespaceQuotasPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { ns } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";

  const managed = ns.quota?.managedByKmc ? ns.quota : null;
  const limits = managed?.limits;
  const externalQuotas = ns.quotas.filter((q) => !q.managedByKmc);

  const form = useForm<NamespaceQuotaFormValues>({
    initialValues: {
      enableQuota: true,
      cpu: limits?.cpu ?? DEFAULT_QUOTA_FORM.cpu,
      memory: limits?.memory ?? DEFAULT_QUOTA_FORM.memory,
      storage: limits?.storage ?? DEFAULT_QUOTA_FORM.storage,
      vms: limits?.vms ?? DEFAULT_QUOTA_FORM.vms,
      pvcs: limits?.pvcs ?? DEFAULT_QUOTA_FORM.pvcs,
    },
    validate: (values) => validateQuotaFormFields(values),
  });

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Update failed", actionData.error);
    }
  }, [actionData]);

  const onSubmit = form.onSubmit((values) => {
    const limitsPayload = quotaLimitsFromForm(values);
    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("enableQuota", values.enableQuota ? "true" : "false");
    if (values.enableQuota) {
      if (limitsPayload.cpu) fd.set("cpu", limitsPayload.cpu);
      if (limitsPayload.memory) fd.set("memory", limitsPayload.memory);
      if (limitsPayload.storage) fd.set("storage", limitsPayload.storage);
      if (limitsPayload.vms != null) fd.set("vms", String(limitsPayload.vms));
      if (limitsPayload.pvcs != null) fd.set("pvcs", String(limitsPayload.pvcs));
    }
    submit(fd, { method: "post" });
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title={`Quotas · ${ns.name}`}
        description={
          <Text span size="sm" c="dimmed">
            {ns.cluster} · ResourceQuota{" "}
            <Text span ff="monospace" size="sm">
              kmc-quota
            </Text>
          </Text>
        }
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Update failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      {externalQuotas.length > 0 && (
        <Alert color="yellow" variant="light" title="External quotas present">
          This namespace also has{" "}
          {externalQuotas.map((q) => q.name).join(", ")} not managed by kmc.
          Those continue to enforce independently; this form only edits{" "}
          <Text span ff="monospace" size="sm">
            kmc-quota
          </Text>
          .
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Resource quotas">
            <NamespaceQuotaFormFields
              form={form}
              showEnableToggle
              description="Hard limits enforced by the Kubernetes ResourceQuota controller. Virt-launcher pods count against CPU/memory requests; DataVolume PVCs against storage and PVC count."
            />
          </FormSection>

          <FormActions>
            <Button component={Link} to={namespacePath(ns)} variant="default">
              Cancel
            </Button>
            {managed && (
              <Button
                type="button"
                color="red"
                variant="light"
                loading={submitting}
                onClick={() => {
                  const fd = new FormData();
                  fd.set("intent", "clear");
                  submit(fd, { method: "post" });
                }}
              >
                Remove quota
              </Button>
            )}
            <Button type="submit" loading={submitting}>
              Save quotas
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
