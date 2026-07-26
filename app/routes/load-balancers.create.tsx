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
import type { Route } from "./+types/load-balancers.create";
import { notifyActionError } from "~/lib/action-feedback";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { logServerError } from "~/lib/errors";
import { loadBalancerPath, validateDns1123Label } from "~/lib/format";
import { createLoadBalancer } from "~/backends/backends.server";
import {
  groupMembership,
  labelsMembership,
  parseMatchLabelsText,
  singleVmMembership,
} from "~/backends/membership";
import { listClusters } from "~/vms/vms.server";
import type {
  BackendMembershipMode,
  BackendPortProtocol,
  ClusterCatalog,
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
  return [{ title: "Create Load Balancer · kmc" }];
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
  const servicePortRaw = String(form.get("servicePort") ?? "80").trim();
  const targetPortRaw = String(form.get("targetPort") ?? "80").trim();
  const protocol = (String(form.get("protocol") ?? "TCP").trim() ||
    "TCP") as BackendPortProtocol;
  const portName = String(form.get("portName") ?? "").trim() || undefined;

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

    if (!Number.isFinite(servicePort) || servicePort < 1 || servicePort > 65535) {
      throw new Error("service port must be 1–65535");
    }
    if (!Number.isFinite(targetPort) || targetPort < 1 || targetPort > 65535) {
      throw new Error("target port must be 1–65535");
    }
    if (protocol !== "TCP" && protocol !== "UDP") {
      throw new Error("protocol must be TCP or UDP");
    }

    const created = await createLoadBalancer({
      cluster,
      namespace,
      name,
      membership,
      ports: [
        {
          name: portName ?? "svc",
          port: servicePort,
          targetPort,
          protocol,
        },
      ],
    });
    return redirect(loadBalancerPath(created));
  } catch (err) {
    return {
      error: logServerError("loadbalancer.create", err, {
        cluster,
        namespace,
        name,
        membershipMode,
        vmName,
      }),
    };
  }
}

export default function CreateLoadBalancerPage({
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
      servicePort: 80,
      targetPort: 80,
      protocol: "TCP" as BackendPortProtocol,
      portName: "",
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
        servicePort: String(values.servicePort),
        targetPort: String(values.targetPort),
        protocol: values.protocol,
        portName: values.portName,
      },
      { method: "post" },
    );
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Create Load Balancer"
        description="Expose pod-network VM(s) via a Service of type LoadBalancer (MetalLB or cloud LB controller assigns the VIP)"
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Create failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <Alert color="gray" variant="light" title="How this works">
        Same backend membership as Ingress (single VM, group stamp, or label
        selector), but the Service type is <code>LoadBalancer</code> instead of
        ClusterIP + Ingress. Requires a controller that implements LoadBalancer
        Services. Multus guest IPs are not used as backends.
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
              description="DNS-1123 name for the LoadBalancer Service"
              placeholder="my-app-lb"
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
            )}

            {form.values.membershipMode === "labels" && (
              <Textarea
                label="Match labels"
                description="Pod-template labels on virt-launcher (key=value, one per line or comma-separated)."
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
                The Service selects virt-launcher pod IPs only.
              </Alert>
            )}
          </FormSection>

          <FormSection title="Ports">
            <NumberInput
              label="Service port"
              description="Port exposed on the LoadBalancer VIP"
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
            <Select
              label="Protocol"
              data={["TCP", "UDP"]}
              value={form.values.protocol}
              onChange={(v) =>
                form.setFieldValue(
                  "protocol",
                  (v as BackendPortProtocol) ?? "TCP",
                )
              }
            />
            <TextInput
              label="Port name"
              description="Optional Kubernetes port name"
              placeholder="http"
              {...form.getInputProps("portName")}
            />
          </FormSection>

          <FormActions>
            <Button component={Link} to="/load-balancers" variant="default">
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Create Load Balancer
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
