import { Alert, Button, Stack } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import {
  Link,
  redirect,
  useFetcher,
  useNavigation,
  useSubmit,
} from "react-router";
import type { Route } from "./+types/load-balancers.$cluster.$namespace.$name.edit";
import { notifyActionError } from "~/lib/action-feedback";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { logServerError } from "~/lib/errors";
import { loadBalancerPath } from "~/lib/format";
import {
  getLoadBalancer,
  updateLoadBalancer,
} from "~/backends/backends.server";
import {
  BackendMembershipFields,
  multusWarningVms,
} from "~/backends/membership-fields";
import {
  BackendPortsFields,
  emptyPortRow,
  type PortRow,
} from "~/backends/ports-fields";
import {
  formatLabelSelector,
  groupMembership,
  labelsMembership,
  parseMatchLabelsText,
  singleVmMembership,
} from "~/backends/membership";
import type {
  BackendMembershipMode,
  BackendPortProtocol,
} from "~/lib/types";

type VmOption = {
  name: string;
  status: string;
  podNetwork: boolean;
  ready: boolean;
};

type VmsFetcherData = { vms: VmOption[] };

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Edit ${params.name ?? "load balancer"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const lb = await getLoadBalancer(cluster, namespace, name);
  return { lb };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { error: "Missing path params" };
  }

  const form = await request.formData();
  const membershipMode = String(
    form.get("membershipMode") ?? "single-vm",
  ).trim() as BackendMembershipMode;
  const vmName = String(form.get("vmName") ?? "").trim();
  const vmNamesRaw = String(form.get("vmNames") ?? "").trim();
  const matchLabelsText = String(form.get("matchLabelsText") ?? "").trim();
  const portsJson = String(form.get("portsJson") ?? "").trim();

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

    const parsed = JSON.parse(portsJson || "[]") as PortRow[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("at least one port is required");
    }
    const ports = parsed.map((p, i) => {
      const port = Number(p.port);
      const targetPort = Number(p.targetPort);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        throw new Error(`service port #${i + 1} must be 1–65535`);
      }
      if (!Number.isFinite(targetPort) || targetPort < 1 || targetPort > 65535) {
        throw new Error(`target port #${i + 1} must be 1–65535`);
      }
      return {
        name: p.name?.trim() || `port-${i}`,
        port,
        targetPort,
        protocol: (String(p.protocol ?? "TCP").toUpperCase() === "UDP"
          ? "UDP"
          : "TCP") as BackendPortProtocol,
      };
    });

    await updateLoadBalancer({
      cluster,
      namespace,
      name,
      membership,
      ports,
    });
    return redirect(loadBalancerPath({ cluster, namespace, name }));
  } catch (err) {
    return {
      error: logServerError("loadbalancer.update", err, {
        cluster,
        namespace,
        name,
      }),
    };
  }
}

export default function EditLoadBalancerPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { lb } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const vmsFetcher = useFetcher<VmsFetcherData>();
  const submitting = navigation.state === "submitting";

  const membership = lb.membership;
  const initialMode: BackendMembershipMode =
    membership.mode === "group" ||
    membership.mode === "labels" ||
    membership.mode === "single-vm"
      ? membership.mode
      : "single-vm";

  const form = useForm({
    initialValues: {
      membershipMode: initialMode,
      vmName: membership.mode === "single-vm" ? membership.vmName : "",
      vmNames: membership.mode === "group" ? membership.vmNames : ([] as string[]),
      matchLabelsText:
        membership.mode === "labels"
          ? formatLabelSelector(membership.matchLabels)
          : "",
      ports: (lb.ports.length
        ? lb.ports.map((p) =>
            emptyPortRow({
              name: p.name ?? "",
              port: p.port,
              targetPort: p.targetPort,
              protocol: (p.protocol === "UDP" ? "UDP" : "TCP") as BackendPortProtocol,
            }),
          )
        : [emptyPortRow()]) as PortRow[],
    },
  });

  useEffect(() => {
    vmsFetcher.load(
      `/api/vms/${lb.cluster}?namespace=${encodeURIComponent(lb.namespace)}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lb.cluster, lb.namespace]);

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
      multusWarningVms(
        form.values.membershipMode,
        vms,
        form.values.vmName,
        form.values.vmNames,
      ).length > 0,
    [
      form.values.membershipMode,
      form.values.vmName,
      form.values.vmNames,
      vms,
    ],
  );

  const onSubmit = form.onSubmit((values) => {
    if (multusBlocked) return;
    submit(
      {
        membershipMode: values.membershipMode,
        vmName: values.vmName,
        vmNames: values.vmNames.join(","),
        matchLabelsText: values.matchLabelsText,
        portsJson: JSON.stringify(values.ports),
      },
      { method: "post" },
    );
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title={`Edit ${lb.name}`}
        description="Update membership and ports on this LoadBalancer Service"
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Update failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      {form.values.membershipMode === "group" && (
        <Alert color="gray" variant="light" title="Group membership">
          Running guests may need a restart before virt-launcher pods pick up
          new group labels and endpoints appear.
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Backend membership">
            <BackendMembershipFields
              membershipMode={form.values.membershipMode}
              onMembershipModeChange={(mode) =>
                form.setFieldValue("membershipMode", mode)
              }
              namespace={lb.namespace}
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

          <FormSection title="Ports">
            <BackendPortsFields
              ports={form.values.ports}
              onChange={(ports) => form.setFieldValue("ports", ports)}
            />
          </FormSection>

          <FormActions>
            <Button
              component={Link}
              to={loadBalancerPath(lb)}
              variant="default"
            >
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
