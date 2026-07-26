import {
  Alert,
  Button,
  Checkbox,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import { Link, redirect, useFetcher, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/ingresses.create";
import { notifyActionError } from "~/lib/action-feedback";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { logServerError } from "~/lib/errors";
import {
  ingressPath,
  loadBalancerCreatePath,
  validateDns1123Label,
} from "~/lib/format";
import { createIngress } from "~/ingresses/ingresses.server";
import { listBackends } from "~/backends/backends.server";
import {
  BackendMembershipFields,
  multusWarningVms,
} from "~/backends/membership-fields";
import {
  groupMembership,
  labelsMembership,
  parseMatchLabelsText,
  singleVmMembership,
} from "~/backends/membership";
import { getSearchParam } from "~/lib/search-params";
import { listClusters } from "~/vms/vms.server";
import type {
  BackendMembershipMode,
  BackendSummary,
  ClusterCatalog,
  CreateIngressRequest,
  IngressPathType,
} from "~/lib/types";

type VmOption = {
  name: string;
  status: string;
  podNetwork: boolean;
  ready: boolean;
};

type VmsFetcherData = { vms: VmOption[] };

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Create Ingress · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const cluster = getSearchParam(url.searchParams, "cluster") ?? "";
  let existingBackends: BackendSummary[] = [];
  try {
    const { items } = await listBackends(cluster || undefined);
    existingBackends = items;
  } catch {
    existingBackends = [];
  }

  return {
    clusters: await listClusters(),
    existingBackends,
    prefill: {
      cluster,
      namespace: getSearchParam(url.searchParams, "namespace") ?? "",
      vmName: getSearchParam(url.searchParams, "vmName") ?? "",
      host: getSearchParam(url.searchParams, "host") ?? "",
      name: getSearchParam(url.searchParams, "name") ?? "",
      existingService: getSearchParam(url.searchParams, "existingService") ?? "",
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const membershipMode = String(
    form.get("membershipMode") ?? "single-vm",
  ).trim() as BackendMembershipMode;
  const vmName = String(form.get("vmName") ?? "").trim();
  const vmNamesRaw = String(form.get("vmNames") ?? "").trim();
  const matchLabelsText = String(form.get("matchLabelsText") ?? "").trim();
  const host = String(form.get("host") ?? "").trim();
  const path = String(form.get("path") ?? "").trim() || "/";
  const pathType = (String(form.get("pathType") ?? "Prefix").trim() ||
    "Prefix") as IngressPathType;
  const servicePortRaw = String(form.get("servicePort") ?? "80").trim();
  const targetPortRaw = String(form.get("targetPort") ?? "80").trim();
  const ingressClassName =
    String(form.get("ingressClassName") ?? "").trim() || undefined;
  const existingServiceName =
    String(form.get("existingServiceName") ?? "").trim() || undefined;
  const tlsSecretName =
    String(form.get("tlsSecretName") ?? "").trim() || undefined;
  const useExisting = form.get("useExistingService") === "true";

  const servicePort = Number(servicePortRaw);
  const targetPort = Number(targetPortRaw);

  try {
    let membership;
    if (!useExisting || !existingServiceName) {
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
      } else {
        throw new Error(`Unsupported membership mode: ${membershipMode}`);
      }
    }

    const payload: CreateIngressRequest = {
      cluster,
      namespace,
      name,
      membership,
      host,
      path,
      pathType,
      servicePort: Number.isFinite(servicePort) ? servicePort : 80,
      targetPort: Number.isFinite(targetPort) ? targetPort : 80,
      ingressClassName,
      existingServiceName: useExisting ? existingServiceName : undefined,
      tlsSecretName,
    };

    await createIngress(payload);
    return redirect(ingressPath(payload));
  } catch (err) {
    return {
      error: logServerError("ingress.create", err, {
        cluster,
        namespace,
        name,
        membershipMode,
        vmName,
      }),
    };
  }
}

export default function CreateIngressPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { clusters, prefill, existingBackends } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const catalogFetcher = useFetcher<ClusterCatalog>();
  const vmsFetcher = useFetcher<VmsFetcherData>();
  const submitting = navigation.state === "submitting";

  const form = useForm({
    initialValues: {
      cluster: prefill.cluster,
      namespace: prefill.namespace,
      name: prefill.name,
      membershipMode: "single-vm" as BackendMembershipMode,
      vmName: prefill.vmName,
      vmNames: prefill.vmName ? [prefill.vmName] : ([] as string[]),
      matchLabelsText: "",
      host: prefill.host,
      path: "/",
      pathType: "Prefix" as IngressPathType,
      servicePort: 80,
      targetPort: 80,
      ingressClassName: "",
      useExistingService: Boolean(prefill.existingService),
      existingServiceName: prefill.existingService,
      tlsSecretName: "",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      namespace: (v) => (!v ? "Required" : null),
      name: validateDns1123Label,
      vmName: (v, values) =>
        !values.useExistingService &&
        values.membershipMode === "single-vm" &&
        !v
          ? "Required"
          : null,
      vmNames: (v, values) =>
        !values.useExistingService &&
        values.membershipMode === "group" &&
        (!v || v.length === 0)
          ? "Select at least one VM"
          : null,
      matchLabelsText: (v, values) => {
        if (values.useExistingService || values.membershipMode !== "labels")
          return null;
        if (!v?.trim()) return "Required";
        try {
          parseMatchLabelsText(v);
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : "Invalid labels";
        }
      },
      existingServiceName: (v, values) =>
        values.useExistingService && !v?.trim() ? "Required" : null,
      host: (v) => {
        if (!v?.trim()) return "Required";
        if (/\s/.test(v)) return "Host must not contain spaces";
        return null;
      },
      path: (v) => (!v?.trim() ? "Required" : null),
      servicePort: (v) =>
        !Number.isFinite(v) || v < 1 || v > 65535 ? "1–65535" : null,
      targetPort: (v) =>
        !Number.isFinite(v) || v < 1 || v > 65535 ? "1–65535" : null,
    },
  });

  useEffect(() => {
    if (!form.values.cluster) return;
    catalogFetcher.load(`/api/catalog/${form.values.cluster}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.cluster]);

  useEffect(() => {
    if (!form.values.cluster || !form.values.namespace) return;
    vmsFetcher.load(
      `/api/vms/${form.values.cluster}?namespace=${encodeURIComponent(form.values.namespace)}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.cluster, form.values.namespace]);

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

  const vms = useMemo(
    () => vmsFetcher.data?.vms ?? [],
    [vmsFetcher.data?.vms],
  );

  const onSubmit = form.onSubmit((values) => {
    if (multusBlocked) return;
    submit(
      {
        cluster: values.cluster,
        namespace: values.namespace,
        name: values.name,
        membershipMode: values.membershipMode,
        vmName: values.vmName,
        vmNames: values.vmNames.join(","),
        matchLabelsText: values.matchLabelsText,
        host: values.host,
        path: values.path,
        pathType: values.pathType,
        servicePort: String(values.servicePort),
        targetPort: String(values.targetPort),
        ingressClassName: values.ingressClassName,
        useExistingService: values.useExistingService ? "true" : "false",
        existingServiceName: values.existingServiceName,
        tlsSecretName: values.tlsSecretName,
      },
      { method: "post" },
    );
  });

  const lbPrefill = useMemo(
    () =>
      loadBalancerCreatePath({
        cluster: form.values.cluster || null,
        namespace: form.values.namespace || null,
        vmName: form.values.vmName || null,
        name: form.values.name || null,
      }),
    [
      form.values.cluster,
      form.values.namespace,
      form.values.vmName,
      form.values.name,
    ],
  );

  const multusBlocked =
    !form.values.useExistingService &&
    multusWarningVms(
      form.values.membershipMode,
      vms,
      form.values.vmName,
      form.values.vmNames,
    ).length > 0;

  const backendOptions = useMemo(() => {
    return existingBackends
      .filter(
        (b) =>
          (!form.values.cluster || b.cluster === form.values.cluster) &&
          (!form.values.namespace || b.namespace === form.values.namespace),
      )
      .map((b) => ({
        value: b.name,
        label: `${b.name} · ${b.serviceType}${b.externalAddress ? ` · ${b.externalAddress}` : ""}`,
      }));
  }, [existingBackends, form.values.cluster, form.values.namespace]);

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Create Ingress"
        description="HTTP(S) route to pod-network VM(s) via ClusterIP Service + Ingress"
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Create failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <Alert color="gray" variant="light" title="How binding works">
        kmc creates a ClusterIP Service that selects virt-launcher pods and an
        Ingress that points at that Service. Membership chooses the selector:
        single VM, stamped group, or existing pod-template labels. Need raw
        TCP/UDP instead?{" "}
        <Text component={Link} to={lbPrefill} size="sm" c="blue.4" span>
          Create a Load Balancer
        </Text>
        .
      </Alert>

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
              onChange={(v) => {
                form.setFieldValue("cluster", v ?? "");
                form.setFieldValue("namespace", "");
                form.setFieldValue("vmName", "");
                form.setFieldValue("vmNames", []);
              }}
            />
            <Select
              label="Namespace"
              placeholder="Select namespace"
              data={namespaceOptions}
              required
              searchable
              disabled={!form.values.cluster}
              value={form.values.namespace || null}
              error={form.errors.namespace}
              onChange={(v) => {
                form.setFieldValue("namespace", v ?? "");
                form.setFieldValue("vmName", "");
                form.setFieldValue("vmNames", []);
              }}
            />
          </FormSection>

          <FormSection title="Identity">
            <TextInput
              label="Name"
              description="DNS-1123 name shared by the Ingress and companion Service"
              placeholder="my-app"
              required
              {...form.getInputProps("name")}
            />
          </FormSection>

          <FormSection title="Backend">
            <Checkbox
              label="Use existing Service (expose-existing)"
              description="Point this Ingress at a kmc Load Balancer or backend Service instead of creating a companion ClusterIP"
              checked={form.values.useExistingService}
              onChange={(e) =>
                form.setFieldValue("useExistingService", e.currentTarget.checked)
              }
            />
            {form.values.useExistingService ? (
              <Select
                label="Existing Service"
                placeholder={
                  form.values.namespace
                    ? "Select backend Service"
                    : "Select namespace first"
                }
                data={backendOptions}
                searchable
                required
                disabled={!form.values.namespace}
                value={form.values.existingServiceName || null}
                error={form.errors.existingServiceName}
                onChange={(v) => {
                  form.setFieldValue("existingServiceName", v ?? "");
                  const match = existingBackends.find(
                    (b) =>
                      b.name === v &&
                      b.namespace === form.values.namespace &&
                      b.cluster === form.values.cluster,
                  );
                  if (match?.ports[0]) {
                    form.setFieldValue("servicePort", match.ports[0].port);
                  }
                }}
                nothingFoundMessage="No kmc backends in this namespace"
              />
            ) : (
              <BackendMembershipFields
                membershipMode={form.values.membershipMode}
                onMembershipModeChange={(mode) =>
                  form.setFieldValue("membershipMode", mode)
                }
                namespace={form.values.namespace}
                vmName={form.values.vmName}
                onVmNameChange={(name) => form.setFieldValue("vmName", name)}
                vmNameError={form.errors.vmName}
                vmNames={form.values.vmNames}
                onVmNamesChange={(names) => form.setFieldValue("vmNames", names)}
                vmNamesError={form.errors.vmNames}
                matchLabelsText={form.values.matchLabelsText}
                onMatchLabelsTextChange={(text) =>
                  form.setFieldValue("matchLabelsText", text)
                }
                matchLabelsError={form.errors.matchLabelsText}
                vmOptions={vms}
                vmsLoading={vmsFetcher.state !== "idle"}
              />
            )}
          </FormSection>

          <FormSection title="Routing">
            <TextInput
              label="Host"
              placeholder="app.example.com"
              required
              {...form.getInputProps("host")}
            />
            <TextInput
              label="Path"
              placeholder="/"
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
              description={
                form.values.useExistingService
                  ? "Port on the existing Service"
                  : "Port exposed by the ClusterIP Service"
              }
              min={1}
              max={65535}
              required
              {...form.getInputProps("servicePort")}
            />
            {!form.values.useExistingService && (
              <NumberInput
                label="Target port"
                description="Port on the virt-launcher pod / guest"
                min={1}
                max={65535}
                required
                {...form.getInputProps("targetPort")}
              />
            )}
            <TextInput
              label="Ingress class"
              description="Optional ingressClassName (cluster default if empty)"
              placeholder="nginx"
              {...form.getInputProps("ingressClassName")}
            />
            <TextInput
              label="TLS secret"
              description="Optional Kubernetes TLS secret name in this namespace (enables https for the host)"
              placeholder="my-app-tls"
              {...form.getInputProps("tlsSecretName")}
            />
          </FormSection>

          <FormActions>
            <Button component={Link} to="/ingresses" variant="default">
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={multusBlocked}>
              Create Ingress
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
