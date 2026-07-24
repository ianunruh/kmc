import { Alert, Button, Code, Select, Stack, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import { Link, redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/floating-ips.create";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { logServerError } from "~/lib/errors";
import { floatingIpsListPath, vpcPath } from "~/lib/format";
import { getSearchParam } from "~/lib/search-params";
import { associateFloatingIp, listFloatingIpEligibleVpcs } from "~/vpcs/vpcs.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Associate floating IP · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const eligible = await listFloatingIpEligibleVpcs();
  return {
    eligible,
    prefill: {
      cluster: getSearchParam(url.searchParams, "cluster") ?? "",
      namespace: getSearchParam(url.searchParams, "namespace") ?? "",
      vpc: getSearchParam(url.searchParams, "vpc") ?? "",
      targetVm: getSearchParam(url.searchParams, "targetVm") ?? "",
      publicIpv4: getSearchParam(url.searchParams, "publicIpv4") ?? "",
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const vpcName = String(form.get("vpcName") ?? "").trim();
  const targetVm = String(form.get("targetVm") ?? "").trim() || undefined;
  const privateIpv4 = String(form.get("privateIpv4") ?? "").trim() || undefined;
  const publicIpv4 = String(form.get("publicIpv4") ?? "").trim() || undefined;

  if (!cluster || !namespace || !vpcName) {
    return { error: "Cluster, namespace, and VPC are required" };
  }
  if (!targetVm && !privateIpv4) {
    return { error: "Select a target VM or enter a private IPv4" };
  }

  try {
    await associateFloatingIp({
      cluster,
      namespace,
      vpcName,
      targetVm,
      privateIpv4,
      publicIpv4,
    });
    return redirect(floatingIpsListPath({ cluster, namespace, vpc: vpcName }));
  } catch (err) {
    return {
      error: logServerError("floatingIp.associate", err, {
        cluster,
        namespace,
        vpcName,
        targetVm,
        privateIpv4,
        publicIpv4,
      }),
    };
  }
}

export default function AssociateFloatingIpPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { eligible, prefill } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Associate failed", actionData.error);
    }
  }, [actionData]);

  const form = useForm({
    initialValues: {
      cluster: prefill.cluster,
      vpcKey:
        prefill.cluster && prefill.namespace && prefill.vpc
          ? `${prefill.cluster}/${prefill.namespace}/${prefill.vpc}`
          : "",
      targetVm: prefill.targetVm,
      privateIpv4: "",
      publicIpv4: prefill.publicIpv4,
      targetMode: (prefill.targetVm ? "vm" : "vm") as "vm" | "ip",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      vpcKey: (v) => (!v ? "Required" : null),
      targetVm: (v, values) => (values.targetMode === "vm" && !v ? "Select a VM" : null),
      privateIpv4: (v, values) =>
        values.targetMode === "ip" && !v.trim() ? "Private IPv4 is required" : null,
    },
  });

  // Sync cluster from vpcKey
  const selected = useMemo(() => {
    const key = form.values.vpcKey;
    if (!key) return null;
    return eligible.find((e) => `${e.cluster}/${e.namespace}/${e.name}` === key);
  }, [eligible, form.values.vpcKey]);

  const clusterOptions = useMemo(() => {
    const set = new Set(eligible.map((e) => e.cluster));
    return Array.from(set).sort();
  }, [eligible]);

  const vpcOptions = useMemo(() => {
    return eligible
      .filter((e) => !form.values.cluster || e.cluster === form.values.cluster)
      .map((e) => ({
        value: `${e.cluster}/${e.namespace}/${e.name}`,
        label: `${e.namespace}/${e.name} · ${e.floatingCount} float(s)${
          e.agentStatus ? ` · agent ${e.agentStatus}` : ""
        }`,
      }));
  }, [eligible, form.values.cluster]);

  const vmOptions = useMemo(() => {
    if (!selected) return [];
    return selected.targetVms.map((vm) => ({
      value: vm.name,
      label: vm.allocatedIpv4 ? `${vm.name} (${vm.allocatedIpv4})` : vm.name,
    }));
  }, [selected]);

  const publicOptions = useMemo(() => {
    const held = selected?.heldPublicIps ?? [];
    return held.map((ip) => ({
      value: ip,
      label: `${ip} (held)`,
    }));
  }, [selected]);

  // Default first eligible when empty
  useEffect(() => {
    if (!form.values.cluster && clusterOptions[0]) {
      form.setFieldValue("cluster", clusterOptions[0]);
    }
  }, [clusterOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!form.values.vpcKey && vpcOptions[0]) {
      form.setFieldValue("vpcKey", vpcOptions[0].value);
    }
  }, [vpcOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = form.onSubmit((values) => {
    if (!selected) return;
    const fd = new FormData();
    fd.set("cluster", selected.cluster);
    fd.set("namespace", selected.namespace);
    fd.set("vpcName", selected.name);
    if (values.targetMode === "vm") {
      fd.set("targetVm", values.targetVm);
    } else {
      fd.set("privateIpv4", values.privateIpv4.trim());
    }
    if (values.publicIpv4.trim()) {
      fd.set("publicIpv4", values.publicIpv4.trim());
    }
    submit(fd, { method: "post" });
  });

  const blocked = eligible.length === 0;

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Associate floating IP"
        description="Map a public Multus address through a router external gateway to a private VM (1:1 DNAT/SNAT)."
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Associate failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      {blocked && (
        <Alert color="yellow" variant="light" title="No eligible VPCs">
          Floating IPs require a VPC with private IPAM and a shared router with an
          external gateway. Create a VPC, attach a router, enable external, then return
          here.
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="VPC">
            <Select
              label="Cluster"
              data={clusterOptions}
              searchable
              required
              disabled={blocked}
              {...form.getInputProps("cluster")}
              onChange={(v) => {
                form.setFieldValue("cluster", v ?? "");
                form.setFieldValue("vpcKey", "");
                form.setFieldValue("targetVm", "");
              }}
            />
            <Select
              label="VPC"
              description="Must have a shared router with an external gateway."
              data={vpcOptions}
              searchable
              required
              disabled={blocked}
              {...form.getInputProps("vpcKey")}
              onChange={(v) => {
                form.setFieldValue("vpcKey", v ?? "");
                form.setFieldValue("targetVm", "");
              }}
            />
            {selected && (
              <Text size="xs" c="dimmed">
                Router <Code>{selected.routerName ?? "—"}</Code>
                {selected.publicNetwork ? ` · egress ${selected.publicNetwork}` : ""}
                {selected.cidr ? ` · ${selected.cidr}` : ""} ·{" "}
                <Link to={vpcPath(selected)}>open VPC</Link>
              </Text>
            )}
          </FormSection>

          <FormSection title="Target">
            <Select
              label="Target mode"
              data={[
                { value: "vm", label: "VM (from IPAM)" },
                { value: "ip", label: "Private IPv4" },
              ]}
              disabled={blocked}
              {...form.getInputProps("targetMode")}
            />
            {form.values.targetMode === "vm" ? (
              <Select
                label="Target VM"
                description="Private address is taken from kmc IPAM for this VPC attachment."
                data={vmOptions}
                searchable
                required
                disabled={blocked || !selected}
                {...form.getInputProps("targetVm")}
              />
            ) : (
              <TextInput
                label="Private IPv4"
                description="Must be inside the VPC CIDR."
                placeholder="10.0.0.50"
                required
                disabled={blocked}
                {...form.getInputProps("privateIpv4")}
              />
            )}
          </FormSection>

          <FormSection title="Public address">
            {(selected?.heldPublicIps.length ?? 0) > 0 ? (
              <Select
                label="Public IPv4"
                description="Clear to allocate a new free address. Held entries were disassociated but not released."
                placeholder="Allocate new from pool"
                data={publicOptions}
                searchable
                clearable
                disabled={blocked}
                value={form.values.publicIpv4 || null}
                onChange={(v) => form.setFieldValue("publicIpv4", v ?? "")}
              />
            ) : (
              <TextInput
                label="Public IPv4 (optional)"
                description="Leave empty to allocate the next free address from the router’s public Multus pool."
                placeholder="auto"
                disabled={blocked}
                {...form.getInputProps("publicIpv4")}
              />
            )}
          </FormSection>

          <FormActions>
            <Button
              component={Link}
              to={floatingIpsListPath()}
              variant="default"
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" color="teal" loading={submitting} disabled={blocked}>
              Associate
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
