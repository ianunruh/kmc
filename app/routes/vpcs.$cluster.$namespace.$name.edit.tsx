import {
  Alert,
  Button,
  Checkbox,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect } from "react";
import { Link, redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/vpcs.$cluster.$namespace.$name.edit";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { logServerError } from "~/lib/errors";
import { vpcPath } from "~/lib/format";
import { getVpc, updateVpc } from "~/vpcs/vpcs.server";
import type { UpdateVpcRequest } from "~/lib/types";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Edit ${params.name ?? "VPC"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  return { vpc: await getVpc(cluster, namespace, name) };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { error: "Missing path params" };
  }

  const form = await request.formData();
  const description = String(form.get("description") ?? "").trim() || undefined;
  const enableIpam = String(form.get("enableIpam") ?? "") === "true";
  const cidr = enableIpam
    ? String(form.get("cidr") ?? "").trim() || undefined
    : undefined;
  const gateway = enableIpam
    ? String(form.get("gateway") ?? "").trim() || undefined
    : undefined;
  const dnsRaw = enableIpam ? String(form.get("dns") ?? "").trim() : "";
  const dns = dnsRaw
    ? dnsRaw
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const payload: UpdateVpcRequest = {
    cluster,
    namespace,
    name,
    description,
    cidr,
    gateway,
    dns,
  };

  try {
    await updateVpc(payload);
    return redirect(vpcPath({ cluster, namespace, name }));
  } catch (err) {
    return {
      error: logServerError("vpc.update", err, { cluster, namespace, name }),
    };
  }
}

export default function EditVpcPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { vpc } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";

  const form = useForm({
    initialValues: {
      description: vpc.description ?? "",
      enableIpam: Boolean(vpc.cidr),
      cidr: vpc.cidr ?? "",
      gateway: vpc.gateway ?? "",
      dns: (vpc.dns ?? []).join(", "),
    },
    validate: {
      cidr: (v, values) => {
        if (!values.enableIpam) return null;
        if (!v?.trim()) return "CIDR required when IPAM is enabled";
        if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(v.trim())) {
          return "Expected a.b.c.d/nn";
        }
        return null;
      },
    },
  });

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Update failed", actionData.error);
    }
  }, [actionData]);

  const onSubmit = form.onSubmit((values) => {
    const fd = new FormData();
    if (values.description) fd.set("description", values.description);
    fd.set("enableIpam", values.enableIpam ? "true" : "false");
    if (values.enableIpam) {
      fd.set("cidr", values.cidr);
      if (values.gateway) fd.set("gateway", values.gateway);
      if (values.dns) fd.set("dns", values.dns);
    }
    submit(fd, { method: "post" });
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title={`Edit ${vpc.name}`}
        description={
          <Text span size="sm" c="dimmed">
            {vpc.cluster}/{vpc.namespace} · VLAN {vpc.vlan} · name and VLAN are
            immutable
          </Text>
        }
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Update failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      {vpc.attachedCount > 0 && (
        <Alert color="yellow" variant="light" title="VMs attached">
          {vpc.attachedCount} VM(s) still use this network. Changing or clearing
          IPAM does not reconfigure existing guests — only new launches pick up
          the updated pool.
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Identity">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <TextInput label="Cluster" value={vpc.cluster} disabled />
              <TextInput label="Namespace" value={vpc.namespace} disabled />
              <TextInput label="Name" value={vpc.name} disabled />
              <TextInput label="VLAN" value={String(vpc.vlan)} disabled />
            </SimpleGrid>
            <Textarea
              label="Description"
              minRows={2}
              value={form.values.description}
              onChange={(e) =>
                form.setFieldValue("description", e.currentTarget.value)
              }
            />
          </FormSection>

          <FormSection title="Private IPAM (optional)">
            <Checkbox
              label="Enable private IPAM"
              description="Allocate static IPv4 addresses from a CIDR via cloud-init netplan when launching VMs on this VPC"
              checked={form.values.enableIpam}
              onChange={(e) =>
                form.setFieldValue("enableIpam", e.currentTarget.checked)
              }
            />
            {form.values.enableIpam && (
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                <TextInput
                  label="CIDR"
                  placeholder="10.40.12.0/24"
                  required
                  value={form.values.cidr}
                  error={form.errors.cidr}
                  onChange={(e) =>
                    form.setFieldValue("cidr", e.currentTarget.value)
                  }
                />
                <TextInput
                  label="Gateway"
                  description="Optional — omit for pure L2 (no default route)"
                  placeholder="10.40.12.1"
                  value={form.values.gateway}
                  onChange={(e) =>
                    form.setFieldValue("gateway", e.currentTarget.value)
                  }
                />
                <TextInput
                  label="DNS"
                  description="Comma-separated"
                  placeholder="1.1.1.1, 8.8.8.8"
                  value={form.values.dns}
                  onChange={(e) =>
                    form.setFieldValue("dns", e.currentTarget.value)
                  }
                  style={{ gridColumn: "1 / -1" }}
                />
              </SimpleGrid>
            )}
          </FormSection>

          <FormActions>
            <Button component={Link} to={vpcPath(vpc)} variant="default">
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
