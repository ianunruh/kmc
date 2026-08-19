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
import type { Route } from "./+types/http-routes.$cluster.$namespace.$name.edit";
import { notifyActionError } from "~/lib/action-feedback";
import { FormActions, FormSection, PageHeader } from "~/ui";
import { logServerError } from "~/lib/errors";
import { httpRoutePath } from "~/lib/format";
import {
  getHttpRoute,
  listGateways,
  updateHttpRoute,
} from "~/httproutes/httproutes.server";
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
  GatewayOption,
  HttpRoutePathType,
} from "~/lib/types";
import { tracedLoader } from "~/lib/request-traces.server";

type VmOption = {
  name: string;
  status: string;
  podNetwork: boolean;
  ready: boolean;
};

type VmsFetcherData = { vms: VmOption[] };

const PATH_TYPES: HttpRoutePathType[] = [
  "PathPrefix",
  "Exact",
  "RegularExpression",
];

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Edit ${params.name ?? "HTTP Route"} · kmc` }];
}

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const [route, gateways] = await Promise.all([
    getHttpRoute(cluster, namespace, name),
    listGateways(cluster).catch(() => [] as GatewayOption[]),
  ]);
  return { route, gateways };
});

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { error: "Missing path params" };
  }

  const form = await request.formData();
  const host = String(form.get("host") ?? "").trim();
  const path = String(form.get("path") ?? "").trim() || "/";
  const pathType = (String(form.get("pathType") ?? "PathPrefix").trim() ||
    "PathPrefix") as HttpRoutePathType;
  const servicePort = Number(form.get("servicePort") ?? "80");
  const targetPort = Number(form.get("targetPort") ?? "80");
  const gatewayRef = String(form.get("gatewayRef") ?? "").trim();
  const sectionName = String(form.get("sectionName") ?? "").trim();
  const membershipMode = String(
    form.get("membershipMode") ?? "",
  ).trim() as BackendMembershipMode | "";
  const vmName = String(form.get("vmName") ?? "").trim();
  const vmNamesRaw = String(form.get("vmNames") ?? "").trim();
  const matchLabelsText = String(form.get("matchLabelsText") ?? "").trim();
  const editMembership = form.get("editMembership") === "true";

  const slash = gatewayRef.indexOf("/");
  const gatewayNamespace = slash >= 0 ? gatewayRef.slice(0, slash) : undefined;
  const gatewayName = slash >= 0 ? gatewayRef.slice(slash + 1) : gatewayRef;

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

    await updateHttpRoute({
      cluster,
      namespace,
      name,
      host,
      path,
      pathType,
      servicePort: Number.isFinite(servicePort) ? servicePort : undefined,
      targetPort: Number.isFinite(targetPort) ? targetPort : undefined,
      gatewayName,
      gatewayNamespace: gatewayNamespace ?? null,
      sectionName: sectionName || null,
      membership,
    });
    return redirect(httpRoutePath({ cluster, namespace, name }));
  } catch (err) {
    return {
      error: logServerError("httproute.update", err, {
        cluster,
        namespace,
        name,
      }),
    };
  }
}

export default function EditHttpRoutePage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { route, gateways } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const vmsFetcher = useFetcher<VmsFetcherData>();
  const submitting = navigation.state === "submitting";

  const membership = route.backend?.membership;
  const initialMode: BackendMembershipMode =
    membership?.mode === "group" ||
    membership?.mode === "labels" ||
    membership?.mode === "single-vm"
      ? membership.mode
      : "single-vm";

  const firstRule = route.rules[0];
  const firstMatch = firstRule?.matches[0];
  const parent = route.parentRefs[0];
  const initialGatewayRef = parent
    ? `${parent.namespace || route.namespace}/${parent.name}`
    : "";

  const form = useForm({
    initialValues: {
      host: route.hosts[0] ?? "",
      path: firstMatch?.path ?? "/",
      pathType: (firstMatch?.pathType as HttpRoutePathType) || "PathPrefix",
      servicePort:
        typeof firstMatch?.servicePort === "number"
          ? firstMatch.servicePort
          : route.servicePorts?.[0]?.port ?? 80,
      targetPort:
        typeof route.servicePorts?.[0]?.targetPort === "number"
          ? route.servicePorts[0].targetPort
          : 80,
      gatewayRef: initialGatewayRef,
      sectionName: parent?.sectionName ?? "",
      editMembership: Boolean(route.backend?.exists),
      membershipMode: initialMode,
      vmName:
        membership?.mode === "single-vm" ? membership.vmName : route.vmName ?? "",
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
      gatewayRef: (v) => (!v?.trim() ? "Required" : null),
    },
  });

  useEffect(() => {
    vmsFetcher.load(
      `/api/vms/${route.cluster}?namespace=${encodeURIComponent(route.namespace)}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.cluster, route.namespace]);

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Update failed", actionData.error);
    }
  }, [actionData]);

  const vms = useMemo(
    () => vmsFetcher.data?.vms ?? [],
    [vmsFetcher.data?.vms],
  );

  const selectedGateway = useMemo(
    () => gateways.find((g) => `${g.namespace}/${g.name}` === form.values.gatewayRef),
    [gateways, form.values.gatewayRef],
  );

  const listenerOptions = useMemo(
    () =>
      (selectedGateway?.listeners ?? []).map((l) => ({
        value: l.name,
        label: `${l.name} · ${l.protocol}:${l.port}`,
      })),
    [selectedGateway],
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
    submit(
      {
        host: values.host,
        path: values.path,
        pathType: values.pathType,
        servicePort: String(values.servicePort),
        targetPort: String(values.targetPort),
        gatewayRef: values.gatewayRef,
        sectionName: values.sectionName,
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
        title={`Edit ${route.name}`}
        description="Update host, path, Gateway parent, and optional companion backend"
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Update failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <form onSubmit={onSubmitFixed}>
        <Stack gap="md">
          <FormSection title="Routing">
            <Select
              label="Gateway"
              data={gateways.map((g) => ({
                value: `${g.namespace}/${g.name}`,
                label: `${g.namespace}/${g.name}${g.gatewayClassName ? ` · ${g.gatewayClassName}` : ""}`,
              }))}
              searchable
              required
              value={form.values.gatewayRef || null}
              error={form.errors.gatewayRef}
              onChange={(v) => {
                form.setFieldValue("gatewayRef", v ?? "");
                form.setFieldValue("sectionName", "");
              }}
              nothingFoundMessage="No Gateways in this cluster"
            />
            {listenerOptions.length > 0 && (
              <Select
                label="Listener"
                placeholder="Any listener"
                clearable
                data={listenerOptions}
                value={form.values.sectionName || null}
                onChange={(v) => form.setFieldValue("sectionName", v ?? "")}
              />
            )}
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
              data={PATH_TYPES}
              value={form.values.pathType}
              onChange={(v) =>
                form.setFieldValue(
                  "pathType",
                  (v as HttpRoutePathType) ?? "PathPrefix",
                )
              }
            />
            <NumberInput
              label="Service port"
              min={1}
              max={65535}
              {...form.getInputProps("servicePort")}
            />
            {route.backend?.exists && (
              <NumberInput
                label="Target port"
                description="Companion Service target port"
                min={1}
                max={65535}
                {...form.getInputProps("targetPort")}
              />
            )}
          </FormSection>

          {route.backend?.exists && (
            <FormSection title="Backend membership">
              <BackendMembershipFields
                membershipMode={form.values.membershipMode}
                onMembershipModeChange={(mode) =>
                  form.setFieldValue("membershipMode", mode)
                }
                namespace={route.namespace}
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
            <Button component={Link} to={httpRoutePath(route)} variant="default">
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
