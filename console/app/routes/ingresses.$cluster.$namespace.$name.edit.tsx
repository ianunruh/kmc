import {
  Alert,
  Button,
  NumberInput,
  Select,
  Stack,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import {
  Link,
  redirect,
  useFetcher,
  useNavigation,
  useSubmit,
} from "react-router";
import type { Route } from "./+types/ingresses.$cluster.$namespace.$name.edit";
import { notifyActionError } from "~/lib/action-feedback";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { logServerError } from "~/lib/errors";
import { ingressPath } from "~/lib/format";
import { getIngress, updateIngress } from "~/ingresses/ingresses.server";
import {
  BackendMembershipFields,
  multusWarningVms,
} from "~/backends/membership-fields";
import {
  formatLabelSelector,
  groupMembership,
  labelsMembership,
  parseMatchLabelsText,
  singleVmMembership,
} from "~/backends/membership";
import type {
  BackendMembershipMode,
  IngressPathType,
} from "~/lib/types";

type VmOption = {
  name: string;
  status: string;
  podNetwork: boolean;
  ready: boolean;
};

type VmsFetcherData = { vms: VmOption[] };

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Edit ${params.name ?? "Ingress"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const ing = await getIngress(cluster, namespace, name);
  return { ing };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { error: "Missing path params" };
  }

  const form = await request.formData();
  const host = String(form.get("host") ?? "").trim();
  const path = String(form.get("path") ?? "").trim() || "/";
  const pathType = (String(form.get("pathType") ?? "Prefix").trim() ||
    "Prefix") as IngressPathType;
  const servicePort = Number(form.get("servicePort") ?? "80");
  const targetPort = Number(form.get("targetPort") ?? "80");
  const ingressClassName = String(form.get("ingressClassName") ?? "").trim();
  const tlsSecretName = String(form.get("tlsSecretName") ?? "").trim();
  const clearTls = form.get("clearTls") === "true";
  const membershipMode = String(
    form.get("membershipMode") ?? "",
  ).trim() as BackendMembershipMode | "";
  const vmName = String(form.get("vmName") ?? "").trim();
  const vmNamesRaw = String(form.get("vmNames") ?? "").trim();
  const matchLabelsText = String(form.get("matchLabelsText") ?? "").trim();
  const editMembership = form.get("editMembership") === "true";

  try {
    let membership;
    if (editMembership && membershipMode) {
      if (membershipMode === "single-vm") {
        if (!vmName) throw new Error("target VM is required");
        membership = singleVmMembership(vmName);
      } else if (membershipMode === "group") {
        const vmNames = vmNamesRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (vmNames.length === 0) throw new Error("select at least one VM");
        membership = groupMembership(name, vmNames);
      } else if (membershipMode === "labels") {
        membership = labelsMembership(parseMatchLabelsText(matchLabelsText));
      }
    }

    await updateIngress({
      cluster,
      namespace,
      name,
      host,
      path,
      pathType,
      servicePort: Number.isFinite(servicePort) ? servicePort : undefined,
      targetPort: Number.isFinite(targetPort) ? targetPort : undefined,
      ingressClassName: ingressClassName || null,
      tlsSecretName: clearTls ? null : tlsSecretName || undefined,
      membership,
    });
    return redirect(ingressPath({ cluster, namespace, name }));
  } catch (err) {
    return {
      error: logServerError("ingress.update", err, {
        cluster,
        namespace,
        name,
      }),
    };
  }
}

export default function EditIngressPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { ing } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const vmsFetcher = useFetcher<VmsFetcherData>();
  const submitting = navigation.state === "submitting";

  const membership = ing.backend?.membership;
  const initialMode: BackendMembershipMode =
    membership?.mode === "group" ||
    membership?.mode === "labels" ||
    membership?.mode === "single-vm"
      ? membership.mode
      : "single-vm";

  const firstRule = ing.rules[0];
  const firstPath = firstRule?.paths[0];
  const currentTls = ing.tls?.[0]?.secretName ?? "";

  const form = useForm({
    initialValues: {
      host: firstRule?.host ?? ing.hosts[0] ?? "",
      path: firstPath?.path ?? "/",
      pathType: (firstPath?.pathType as IngressPathType) || "Prefix",
      servicePort:
        typeof firstPath?.servicePort === "number"
          ? firstPath.servicePort
          : ing.servicePorts?.[0]?.port ?? 80,
      targetPort:
        typeof ing.servicePorts?.[0]?.targetPort === "number"
          ? ing.servicePorts[0].targetPort
          : 80,
      ingressClassName: ing.className ?? "",
      tlsSecretName: currentTls,
      clearTls: false,
      editMembership: Boolean(ing.backend?.exists),
      membershipMode: initialMode,
      vmName:
        membership?.mode === "single-vm" ? membership.vmName : ing.vmName ?? "",
      vmNames:
        membership?.mode === "group" ? membership.vmNames : ([] as string[]),
      matchLabelsText:
        membership?.mode === "labels"
          ? formatLabelSelector(membership.matchLabels)
          : "",
    },
    validate: {
      host: (v) => {
        if (!v?.trim()) return "Required";
        if (/\s/.test(v)) return "Host must not contain spaces";
        return null;
      },
      path: (v) => (!v?.trim() ? "Required" : null),
    },
  });

  useEffect(() => {
    vmsFetcher.load(
      `/api/vms/${ing.cluster}?namespace=${encodeURIComponent(ing.namespace)}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ing.cluster, ing.namespace]);

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Update failed", actionData.error);
    }
  }, [actionData]);

  const vms = useMemo(
    () => vmsFetcher.data?.vms ?? [],
    [vmsFetcher.data?.vms],
  );

  const multusBlocked = useMemo(
    () =>
      form.values.editMembership &&
      multusWarningVms(
        form.values.membershipMode,
        vms,
        form.values.vmName,
        form.values.vmNames,
      ).length > 0,
    [
      form.values.editMembership,
      form.values.membershipMode,
      form.values.vmName,
      form.values.vmNames,
      vms,
    ],
  );

  const onSubmitFixed = form.onSubmit((values) => {
    if (multusBlocked) return;
    const hadTls = Boolean(currentTls);
    const nextTls = values.tlsSecretName.trim();
    submit(
      {
        host: values.host,
        path: values.path,
        pathType: values.pathType,
        servicePort: String(values.servicePort),
        targetPort: String(values.targetPort),
        ingressClassName: values.ingressClassName,
        tlsSecretName: nextTls,
        clearTls: hadTls && !nextTls ? "true" : "false",
        editMembership: values.editMembership ? "true" : "false",
        membershipMode: values.membershipMode,
        vmName: values.vmName,
        vmNames: values.vmNames.join(","),
        matchLabelsText: values.matchLabelsText,
      },
      { method: "post" },
    );
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title={`Edit ${ing.name}`}
        description="Update host, path, TLS, and optional companion backend"
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Update failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <form onSubmit={onSubmitFixed}>
        <Stack gap="md">
          <FormSection title="Routing">
            <TextInput
              label="Host"
              required
              {...form.getInputProps("host")}
            />
            <TextInput
              label="Path"
              required
              {...form.getInputProps("path")}
            />
            <Select
              label="Path type"
              data={["Prefix", "Exact", "ImplementationSpecific"]}
              value={form.values.pathType}
              onChange={(v) =>
                form.setFieldValue(
                  "pathType",
                  (v as IngressPathType) ?? "Prefix",
                )
              }
            />
            <NumberInput
              label="Service port"
              min={1}
              max={65535}
              {...form.getInputProps("servicePort")}
            />
            {ing.backend?.exists && (
              <NumberInput
                label="Target port"
                description="Companion Service target port"
                min={1}
                max={65535}
                {...form.getInputProps("targetPort")}
              />
            )}
            <TextInput
              label="Ingress class"
              placeholder="nginx"
              {...form.getInputProps("ingressClassName")}
            />
            <TextInput
              label="TLS secret"
              description="Leave empty to disable TLS"
              placeholder="my-app-tls"
              {...form.getInputProps("tlsSecretName")}
            />
          </FormSection>

          {ing.backend?.exists && (
            <FormSection title="Backend membership">
              <BackendMembershipFields
                membershipMode={form.values.membershipMode}
                onMembershipModeChange={(mode) =>
                  form.setFieldValue("membershipMode", mode)
                }
                namespace={ing.namespace}
                vmName={form.values.vmName}
                onVmNameChange={(name) => form.setFieldValue("vmName", name)}
                vmNames={form.values.vmNames}
                onVmNamesChange={(names) => form.setFieldValue("vmNames", names)}
                matchLabelsText={form.values.matchLabelsText}
                onMatchLabelsTextChange={(text) =>
                  form.setFieldValue("matchLabelsText", text)
                }
                vmOptions={vms}
                vmsLoading={vmsFetcher.state !== "idle"}
              />
            </FormSection>
          )}

          <FormActions>
            <Button component={Link} to={ingressPath(ing)} variant="default">
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={multusBlocked}>
              Save changes
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
