import {
  Alert,
  Button,
  Checkbox,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo } from "react";
import { Link, redirect, useFetcher, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/vpcs.create";
import { notifyActionError } from "~/lib/action-feedback";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { logServerError } from "~/lib/errors";
import { validateDns1123Label, vpcPath } from "~/lib/format";
import { createVpc, listVlanPools } from "~/vpcs/vpcs.server";
import { listClusters } from "~/vms/vms.server";
import { getConfiguredContexts } from "~/lib/k8s/clients.server";
import { clusterHasVlanPools } from "~/lib/ipam/vlan-pools.server";
import type { ClusterCatalog, CreateVpcRequest } from "~/lib/types";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Create VPC · kmc" }];
}

export const loader = tracedLoader(async () => {
  const clusters = await listClusters();
  const contexts = getConfiguredContexts();
  const vlanByCluster: Record<
    string,
    Array<{ id: string; start: number; end: number; bridge: string }>
  > = {};
  for (const id of contexts) {
    if (!(await clusterHasVlanPools(id))) continue;
    vlanByCluster[id] = (await listVlanPools(id)).map((p) => ({
      id: p.id,
      start: p.start,
      end: p.end,
      bridge: p.bridge,
    }));
  }
  return { clusters, vlanByCluster };
});

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const cluster = String(form.get("cluster") ?? "").trim();
  const namespace = String(form.get("namespace") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
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
  const vlanPoolId = String(form.get("vlanPoolId") ?? "").trim() || undefined;

  const payload: CreateVpcRequest = {
    cluster,
    namespace,
    name,
    description,
    cidr,
    gateway,
    dns,
    vlanPoolId,
  };

  try {
    const created = await createVpc(payload);
    return redirect(vpcPath(created));
  } catch (err) {
    return {
      error: logServerError("vpc.create", err, {
        cluster,
        namespace,
        name,
      }),
    };
  }
}

export default function CreateVpcPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { clusters, vlanByCluster } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const catalogFetcher = useFetcher<ClusterCatalog>();
  const submitting = navigation.state === "submitting";

  const reachableWithVlan = useMemo(
    () =>
      clusters.filter(
        (c) => c.reachable && Object.keys(vlanByCluster).includes(c.id),
      ),
    [clusters, vlanByCluster],
  );

  const form = useForm({
    initialValues: {
      cluster: reachableWithVlan[0]?.id ?? "",
      namespace: "",
      name: "",
      description: "",
      enableIpam: false,
      cidr: "",
      gateway: "",
      dns: "",
      vlanPoolId: "",
    },
    validate: {
      cluster: (v) => (!v ? "Required" : null),
      namespace: (v) => (!v ? "Required" : null),
      name: validateDns1123Label,
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
    if (!form.values.cluster) return;
    catalogFetcher.load(`/api/catalog/${form.values.cluster}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load catalog when cluster changes
  }, [form.values.cluster]);

  useEffect(() => {
    const pools = vlanByCluster[form.values.cluster] ?? [];
    if (pools.length === 1) {
      form.setFieldValue("vlanPoolId", pools[0]!.id);
    } else if (
      form.values.vlanPoolId &&
      !pools.some((p) => p.id === form.values.vlanPoolId)
    ) {
      form.setFieldValue("vlanPoolId", pools[0]?.id ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.cluster, vlanByCluster]);

  const namespaces = useMemo(() => {
    return (catalogFetcher.data?.namespaces ?? []).map((n) => n.name);
  }, [catalogFetcher.data]);

  const poolOptions = useMemo(() => {
    return (vlanByCluster[form.values.cluster] ?? []).map((p) => ({
      value: p.id,
      label: `${p.id} · VLAN ${p.start}–${p.end} · ${p.bridge}`,
    }));
  }, [form.values.cluster, vlanByCluster]);

  const selectedPool = (vlanByCluster[form.values.cluster] ?? []).find(
    (p) => p.id === form.values.vlanPoolId,
  );

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Create failed", actionData.error);
    }
  }, [actionData]);

  const onSubmit = form.onSubmit((values) => {
    const fd = new FormData();
    fd.set("cluster", values.cluster);
    fd.set("namespace", values.namespace);
    fd.set("name", values.name);
    if (values.description) fd.set("description", values.description);
    fd.set("enableIpam", values.enableIpam ? "true" : "false");
    if (values.enableIpam) {
      fd.set("cidr", values.cidr);
      if (values.gateway) fd.set("gateway", values.gateway);
      if (values.dns) fd.set("dns", values.dns);
    }
    if (values.vlanPoolId) fd.set("vlanPoolId", values.vlanPoolId);
    submit(fd, { method: "post" });
  });

  if (reachableWithVlan.length === 0) {
    return (
      <Stack gap="md">
        <PageHeader
          title="Create VPC"
          description="Allocate a VLAN and Multus network from a cluster pool"
        />
        <Alert color="yellow" variant="light" title="No VLAN pools">
          No reachable cluster has a <code>VLANPool</code> CR. Apply{" "}
          <code>deploy/controller/examples/vlanpool.yaml</code> (or your own
          range) so the controller can assign VLANs.
        </Alert>
        <FormActions>
          <Button component={Link} to="/vpcs" variant="default">
            Back to VPCs
          </Button>
        </FormActions>
      </Stack>
    );
  }

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title="Create VPC"
        description="Create a VPC CR — the controller assigns a free VLAN and Multus NAD; optionally enable private IPAM"
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Create failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Placement">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <Select
                label="Cluster"
                data={reachableWithVlan.map((c) => c.id)}
                required
                value={form.values.cluster}
                error={form.errors.cluster}
                onChange={(v) => {
                  form.setFieldValue("cluster", v ?? "");
                  form.setFieldValue("namespace", "");
                }}
              />
              <Select
                label="Namespace"
                data={namespaces}
                required
                searchable
                nothingFoundMessage="No namespaces labeled kmc.ianunruh.com/vm-allowed=true"
                value={form.values.namespace}
                error={form.errors.namespace}
                onChange={(v) => form.setFieldValue("namespace", v ?? "")}
              />
            </SimpleGrid>
            <TextInput
              label="Name"
              description="DNS-1123 label; becomes the Multus network name"
              required
              value={form.values.name}
              error={form.errors.name}
              onChange={(e) => form.setFieldValue("name", e.currentTarget.value)}
            />
            <Textarea
              label="Description"
              minRows={2}
              value={form.values.description}
              onChange={(e) =>
                form.setFieldValue("description", e.currentTarget.value)
              }
            />
            {poolOptions.length > 1 && (
              <Select
                label="VLAN pool"
                data={poolOptions}
                value={form.values.vlanPoolId}
                onChange={(v) => form.setFieldValue("vlanPoolId", v ?? "")}
              />
            )}
            {selectedPool && (
              <Text size="xs" c="dimmed">
                Allocates the next free VLAN in {selectedPool.start}–
                {selectedPool.end} on bridge{" "}
                <Text span ff="monospace">
                  {selectedPool.bridge}
                </Text>
                . Pure L2 isolation between VMs on that segment.
              </Text>
            )}
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
                  description="Comma-separated; defaults from vlan pool when empty"
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
            <Button component={Link} to="/vpcs" variant="default">
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Create VPC
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Stack>
  );
}
