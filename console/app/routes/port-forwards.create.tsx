import {
  Alert,
  Button,
  Checkbox,
  Code,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import { Link, redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/port-forwards.create";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { logServerError } from "~/lib/errors";
import { portForwardsListPath, vpcPath } from "~/lib/format";
import { getSearchParam } from "~/lib/search-params";
import { createPortForward, listPortForwardEligibleVpcs } from "~/vpcs/vpcs.server";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Create port forward · kmc" }];
}

export const loader = tracedLoader(async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);
  const eligible = await listPortForwardEligibleVpcs();
  return {
    eligible,
    prefill: {
      cluster: getSearchParam(url.searchParams, "cluster") ?? "",
      namespace: getSearchParam(url.searchParams, "namespace") ?? "",
      vpc: getSearchParam(url.searchParams, "vpc") ?? "",
      targetVm: getSearchParam(url.searchParams, "targetVm") ?? "",
      publicIpv4: getSearchParam(url.searchParams, "publicIpv4") ?? "",
      publicPort: getSearchParam(url.searchParams, "publicPort") ?? "",
      privatePort: getSearchParam(url.searchParams, "privatePort") ?? "",
      protocol: getSearchParam(url.searchParams, "protocol") ?? "tcp",
    },
  };
});

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const vpcName = String(form.get("vpcName") ?? "").trim();
  const targetVm = String(form.get("targetVm") ?? "").trim() || undefined;
  const privateIpv4 = String(form.get("privateIpv4") ?? "").trim() || undefined;
  const publicIpv4 = String(form.get("publicIpv4") ?? "").trim() || undefined;
  const allocatePublic = form.get("allocatePublic") === "true";
  const protocol = String(form.get("protocol") ?? "tcp").trim().toLowerCase();
  const publicPort = Number(form.get("publicPort"));
  const privatePort = Number(form.get("privatePort"));

  if (!cluster || !namespace || !vpcName) {
    return { error: "Cluster, namespace, and VPC are required" };
  }
  if (!targetVm && !privateIpv4) {
    return { error: "Select a target VM or enter a private IPv4" };
  }
  if (protocol !== "tcp" && protocol !== "udp") {
    return { error: 'Protocol must be "tcp" or "udp"' };
  }
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
    return { error: "Public port must be 1–65535" };
  }
  if (!Number.isInteger(privatePort) || privatePort < 1 || privatePort > 65535) {
    return { error: "Private port must be 1–65535" };
  }

  try {
    await createPortForward({
      cluster,
      namespace,
      vpcName,
      targetVm,
      privateIpv4,
      publicIpv4,
      allocatePublic: allocatePublic && !publicIpv4,
      protocol,
      publicPort,
      privatePort,
    });
    return redirect(portForwardsListPath({ cluster, namespace, vpc: vpcName }));
  } catch (err) {
    return {
      error: logServerError("portForward.create", err, {
        cluster,
        namespace,
        vpcName,
        targetVm,
        privateIpv4,
        publicIpv4,
        protocol,
        publicPort,
        privatePort,
      }),
    };
  }
}

export default function CreatePortForwardPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { eligible, prefill } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Create failed", actionData.error);
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
      allocatePublic: false,
      protocol: (prefill.protocol === "udp" ? "udp" : "tcp") as "tcp" | "udp",
      publicPort: prefill.publicPort ? Number(prefill.publicPort) : (22 as number | string),
      privatePort: prefill.privatePort
        ? Number(prefill.privatePort)
        : (22 as number | string),
      targetMode: (prefill.targetVm ? "vm" : "vm") as "vm" | "ip",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      vpcKey: (v) => (!v ? "Required" : null),
      targetVm: (v, values) => (values.targetMode === "vm" && !v ? "Select a VM" : null),
      privateIpv4: (v, values) =>
        values.targetMode === "ip" && !v.trim() ? "Private IPv4 is required" : null,
      publicPort: (v) => {
        const n = Number(v);
        return !Number.isInteger(n) || n < 1 || n > 65535 ? "1–65535" : null;
      },
      privatePort: (v) => {
        const n = Number(v);
        return !Number.isInteger(n) || n < 1 || n > 65535 ? "1–65535" : null;
      },
    },
  });

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
        label: `${e.namespace}/${e.name} · ${e.portForwardCount} rule(s)${
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
    if (!selected) return [];
    return selected.publicIpv4Options.map((ip) => ({
      value: ip,
      label:
        ip === selected.externalPrimaryIpv4
          ? `${ip} (router external)`
          : `${ip}`,
    }));
  }, [selected]);

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

  // Default public IP to router external when empty.
  useEffect(() => {
    if (!selected) return;
    if (form.values.publicIpv4) return;
    if (selected.externalPrimaryIpv4) {
      form.setFieldValue("publicIpv4", selected.externalPrimaryIpv4);
    } else if (selected.publicIpv4Options[0]) {
      form.setFieldValue("publicIpv4", selected.publicIpv4Options[0]);
    }
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = form.onSubmit((values) => {
    if (!selected) return;
    const fd = new FormData();
    fd.set("cluster", selected.cluster);
    fd.set("namespace", selected.namespace);
    fd.set("vpcName", selected.name);
    fd.set("protocol", values.protocol);
    fd.set("publicPort", String(Number(values.publicPort)));
    fd.set("privatePort", String(Number(values.privatePort)));
    if (values.targetMode === "vm") {
      fd.set("targetVm", values.targetVm);
    } else {
      fd.set("privateIpv4", values.privateIpv4.trim());
    }
    if (values.allocatePublic) {
      fd.set("allocatePublic", "true");
    } else if (values.publicIpv4.trim()) {
      fd.set("publicIpv4", values.publicIpv4.trim());
    }
    submit(fd, { method: "post" });
  });

  const blocked = eligible.length === 0;

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Create port forward"
        description="Map a single public port through a router external gateway to a private VM port — without claiming a full floating IP."
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Create failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      {blocked && (
        <Alert color="yellow" variant="light" title="No eligible VPCs">
          Port forwards require a VPC with private IPAM and a shared router with an
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
                form.setFieldValue("publicIpv4", "");
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
                form.setFieldValue("publicIpv4", "");
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
            <NumberInput
              label="Private port"
              description="Guest listen port."
              min={1}
              max={65535}
              required
              disabled={blocked}
              {...form.getInputProps("privatePort")}
            />
          </FormSection>

          <FormSection title="Public mapping">
            <Select
              label="Protocol"
              data={[
                { value: "tcp", label: "TCP" },
                { value: "udp", label: "UDP" },
              ]}
              required
              disabled={blocked}
              {...form.getInputProps("protocol")}
            />
            <NumberInput
              label="Public port"
              description="Listen port on the public address."
              min={1}
              max={65535}
              required
              disabled={blocked}
              {...form.getInputProps("publicPort")}
            />
            <Checkbox
              label="Allocate a new public IP"
              description="Reserves a held floating IP for shared port maps (not a full 1:1 association)."
              disabled={blocked}
              checked={form.values.allocatePublic}
              onChange={(e) => {
                form.setFieldValue("allocatePublic", e.currentTarget.checked);
                if (e.currentTarget.checked) {
                  form.setFieldValue("publicIpv4", "");
                }
              }}
            />
            {!form.values.allocatePublic && (
              <Select
                label="Public IPv4"
                description="Defaults to the router external primary. Held floating IPs can host many port rules."
                data={publicOptions}
                searchable
                required={!form.values.allocatePublic}
                disabled={blocked || !selected}
                value={form.values.publicIpv4 || null}
                onChange={(v) => form.setFieldValue("publicIpv4", v ?? "")}
              />
            )}
          </FormSection>

          <FormActions>
            <Button
              component={Link}
              to={portForwardsListPath()}
              variant="default"
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" color="teal" loading={submitting} disabled={blocked}>
              Create port forward
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
