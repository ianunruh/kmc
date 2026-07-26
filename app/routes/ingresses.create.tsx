import {
  Alert,
  Button,
  MultiSelect,
  NumberInput,
  Select,
  Stack,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import { Link, redirect, useFetcher, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/ingresses.create";
import { notifyActionError } from "~/lib/action-feedback";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { logServerError } from "~/lib/errors";
import { ingressPath, validateDns1123Label } from "~/lib/format";
import { createIngress } from "~/ingresses/ingresses.server";
import {
  groupMembership,
  labelsMembership,
  parseMatchLabelsText,
  singleVmMembership,
} from "~/backends/membership";
import { listClusters } from "~/vms/vms.server";
import type {
  BackendMembershipMode,
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

const MEMBERSHIP_OPTIONS: Array<{ value: BackendMembershipMode; label: string }> =
  [
    { value: "single-vm", label: "Single VM" },
    { value: "group", label: "VM group" },
    { value: "labels", label: "Label selector" },
  ];

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Create Ingress · kmc" }];
}

export async function loader() {
  return { clusters: await listClusters() };
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

  const servicePort = Number(servicePortRaw);
  const targetPort = Number(targetPortRaw);

  try {
    let membership;
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
  const { clusters } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const catalogFetcher = useFetcher<ClusterCatalog>();
  const vmsFetcher = useFetcher<VmsFetcherData>();
  const submitting = navigation.state === "submitting";

  const form = useForm({
    initialValues: {
      cluster: "",
      namespace: "",
      name: "",
      membershipMode: "single-vm" as BackendMembershipMode,
      vmName: "",
      vmNames: [] as string[],
      matchLabelsText: "",
      host: "",
      path: "/",
      pathType: "Prefix" as IngressPathType,
      servicePort: 80,
      targetPort: 80,
      ingressClassName: "",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      namespace: (v) => (!v ? "Required" : null),
      name: validateDns1123Label,
      vmName: (v, values) =>
        values.membershipMode === "single-vm" && !v ? "Required" : null,
      vmNames: (v, values) =>
        values.membershipMode === "group" && (!v || v.length === 0)
          ? "Select at least one VM"
          : null,
      matchLabelsText: (v, values) => {
        if (values.membershipMode !== "labels") return null;
        if (!v?.trim()) return "Required";
        try {
          parseMatchLabelsText(v);
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : "Invalid labels";
        }
      },
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
  const vmOptions = useMemo(
    () =>
      vms.map((vm) => ({
        value: vm.name,
        label: `${vm.name} · ${vm.status}${vm.podNetwork ? "" : " · Multus"}`,
      })),
    [vms],
  );

  const selectedVm = useMemo(
    () => vms.find((vm) => vm.name === form.values.vmName),
    [vms, form.values.vmName],
  );

  const selectedGroupVms = useMemo(
    () => vms.filter((vm) => form.values.vmNames.includes(vm.name)),
    [vms, form.values.vmNames],
  );
  const multusWarningVms = useMemo(() => {
    if (form.values.membershipMode === "single-vm") {
      return selectedVm && !selectedVm.podNetwork ? [selectedVm] : [];
    }
    if (form.values.membershipMode === "group") {
      return selectedGroupVms.filter((vm) => !vm.podNetwork);
    }
    return [];
  }, [form.values.membershipMode, selectedVm, selectedGroupVms]);

  const onSubmit = form.onSubmit((values) => {
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
      },
      { method: "post" },
    );
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Create Ingress"
        description="Expose pod-network VM(s) via ClusterIP Service + Ingress (same CNI path as any backend pod)"
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Create failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <Alert color="gray" variant="light" title="How binding works">
        kmc creates a ClusterIP Service that selects virt-launcher pods and an
        Ingress that points at that Service. Membership chooses the Service
        selector: a single VM (<code>kubevirt.io/vm</code>), a stamped group
        label, or arbitrary pod-template labels. Multus guest IPs are not used
        as backends.
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

          <FormSection title="Backend membership">
            <Select
              label="Membership"
              data={MEMBERSHIP_OPTIONS}
              required
              value={form.values.membershipMode}
              onChange={(v) =>
                form.setFieldValue(
                  "membershipMode",
                  (v as BackendMembershipMode) ?? "single-vm",
                )
              }
            />

            {form.values.membershipMode === "single-vm" && (
              <Select
                label="Virtual machine"
                placeholder={
                  form.values.namespace ? "Select VM" : "Select namespace first"
                }
                data={vmOptions}
                required
                searchable
                disabled={!form.values.namespace}
                value={form.values.vmName || null}
                error={form.errors.vmName}
                onChange={(v) => form.setFieldValue("vmName", v ?? "")}
                nothingFoundMessage={
                  vmsFetcher.state !== "idle"
                    ? "Loading…"
                    : "No VMs in this namespace"
                }
              />
            )}

            {form.values.membershipMode === "group" && (
              <>
                <MultiSelect
                  label="Virtual machines"
                  description="kmc stamps kmc.ianunruh.com/backend-group on each VM pod template. Running VMs may need a restart before endpoints appear."
                  placeholder={
                    form.values.namespace
                      ? "Select one or more VMs"
                      : "Select namespace first"
                  }
                  data={vmOptions}
                  required
                  searchable
                  disabled={!form.values.namespace}
                  value={form.values.vmNames}
                  error={form.errors.vmNames}
                  onChange={(v) => form.setFieldValue("vmNames", v)}
                  nothingFoundMessage={
                    vmsFetcher.state !== "idle"
                      ? "Loading…"
                      : "No VMs in this namespace"
                  }
                />
              </>
            )}

            {form.values.membershipMode === "labels" && (
              <Textarea
                label="Match labels"
                description="Pod-template labels on virt-launcher (key=value, one per line or comma-separated). Labels must already exist on the VMs."
                placeholder={"app=web\ntier=frontend"}
                minRows={3}
                required
                {...form.getInputProps("matchLabelsText")}
              />
            )}

            {multusWarningVms.length > 0 && (
              <Alert color="yellow" variant="light" title="Multus network">
                {multusWarningVms.length === 1
                  ? `${multusWarningVms[0].name} uses Multus, not the pod network.`
                  : `${multusWarningVms.length} selected VMs use Multus.`}{" "}
                The Service still selects virt-launcher pod IPs — Multus guest
                addresses are not used as Ingress backends.
              </Alert>
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
              description="Port exposed by the ClusterIP Service"
              min={1}
              max={65535}
              required
              {...form.getInputProps("servicePort")}
            />
            <NumberInput
              label="Target port"
              description="Port on the virt-launcher pod / guest"
              min={1}
              max={65535}
              required
              {...form.getInputProps("targetPort")}
            />
            <TextInput
              label="Ingress class"
              description="Optional ingressClassName (cluster default if empty)"
              placeholder="nginx"
              {...form.getInputProps("ingressClassName")}
            />
          </FormSection>

          <FormActions>
            <Button component={Link} to="/ingresses" variant="default">
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Create Ingress
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
