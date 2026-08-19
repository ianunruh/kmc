import {
  Alert,
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useEffect, useMemo, type ReactNode } from "react";
import { Link, redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/vms.$cluster.$namespace.$name.edit";
import { FormActions, FormSection, PageHeader, StatusBadge } from "~/ui";
import { notifyActionError } from "~/lib/action-feedback";
import { logServerError } from "~/lib/errors";
import {
  canEditVmSpec,
  formatLabelsText,
  isVmStopped,
  parseCpuCores,
  parseLabelsText,
  vmPath,
} from "~/lib/format";
import { getClusterCatalog } from "~/lib/k8s/catalog.server";
import { instanceTypeSelectData } from "~/instancetypes/options";
import type { UpdateVmRequest } from "~/lib/types";
import { VM_RUN_STRATEGIES } from "~/lib/types";
import { getVm, updateVm } from "~/vms/vms.server";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Edit ${params.name ?? "VM"} · kmc` }];
}

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const [vm, catalog] = await Promise.all([
    getVm(cluster, namespace, name),
    getClusterCatalog(cluster),
  ]);
  return { vm, catalog };
});

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { error: "Missing path params" };
  }

  const form = await request.formData();
  const labelsText = String(form.get("labelsText") ?? "");
  const parsed = parseLabelsText(labelsText);
  if (parsed.error || !parsed.labels) {
    return { error: parsed.error ?? "Invalid labels" };
  }

  const applySpec = String(form.get("applySpec") ?? "") === "true";
  const payload: UpdateVmRequest = {
    cluster,
    namespace,
    name,
    labels: parsed.labels,
  };

  if (applySpec) {
    const sizeModeRaw = String(form.get("sizeMode") ?? "manual");
    const sizeMode = sizeModeRaw === "instancetype" ? "instancetype" : "manual";
    const runStrategy = String(form.get("runStrategy") ?? "").trim();
    const instanceType = String(form.get("instanceType") ?? "").trim() || undefined;
    const preference = String(form.get("preference") ?? "").trim() || undefined;
    const cpuCoresRaw = String(form.get("cpuCores") ?? "").trim();
    const memory = String(form.get("memory") ?? "").trim() || undefined;

    payload.spec = {
      runStrategy,
      sizeMode,
      instanceType,
      preference,
      memory,
    };

    if (sizeMode === "manual") {
      const cpuCores = Number(cpuCoresRaw || 1);
      if (!Number.isFinite(cpuCores) || cpuCores < 1) {
        return { error: "CPU cores must be a positive number" };
      }
      payload.spec.cpuCores = cpuCores;
      if (!memory) return { error: "Memory is required" };
    } else if (!instanceType) {
      return { error: "Instance type is required" };
    }
  }

  try {
    await updateVm(payload);
    return redirect(vmPath({ cluster, namespace, name }));
  } catch (err) {
    if (err instanceof Response) throw err;
    return {
      error: logServerError("vm.update", err, { cluster, namespace, name }),
    };
  }
}

export default function EditVmPage({ loaderData, actionData }: Route.ComponentProps) {
  const { vm, catalog } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state === "submitting";
  const specEditable = canEditVmSpec(vm);

  const initialSizeMode: "manual" | "instancetype" =
    vm.instanceType && catalog.hasInstanceTypes ? "instancetype" : "manual";

  const form = useForm({
    initialValues: {
      runStrategy:
        vm.runStrategy &&
        (VM_RUN_STRATEGIES as readonly string[]).includes(vm.runStrategy)
          ? vm.runStrategy
          : "Always",
      sizeMode: initialSizeMode,
      instanceType: vm.instanceType ?? "",
      preference: vm.preference ?? "",
      cpuCores: parseCpuCores(vm.cpu),
      memory: vm.memory ?? "1Gi",
      labelsText: formatLabelsText(vm.labels),
    },
    validate: {
      runStrategy: (v) => (!v ? "Required" : null),
      memory: (v, values) => (values.sizeMode === "manual" && !v ? "Required" : null),
      instanceType: (v, values) =>
        values.sizeMode === "instancetype" && !v ? "Required" : null,
      labelsText: (v) => {
        const parsed = parseLabelsText(v);
        return parsed.error ?? null;
      },
    },
  });

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      notifyActionError("Update failed", actionData.error);
    }
  }, [actionData]);

  const instanceTypeOptions = useMemo(
    () => instanceTypeSelectData(catalog.instanceTypes ?? []),
    [catalog.instanceTypes],
  );
  const guestStopped = isVmStopped(vm);

  const preferenceOptions = useMemo(
    () => (catalog.preferences ?? []).map((p) => p.name),
    [catalog.preferences],
  );

  const onSubmit = form.onSubmit((values) => {
    const data: Record<string, string> = {
      labelsText: values.labelsText,
      applySpec: specEditable ? "true" : "false",
    };
    if (specEditable) {
      data.runStrategy = values.runStrategy;
      data.sizeMode = values.sizeMode;
      data.instanceType = values.instanceType;
      data.preference = values.preference;
      data.cpuCores = String(values.cpuCores);
      data.memory = values.memory;
    }
    submit(data, { method: "post" });
  });

  return (
    <Stack gap="md" pb={80}>
      <PageHeader
        title={`Edit ${vm.name}`}
        description={
          <Text span size="sm" c="dimmed">
            {vm.cluster} / {vm.namespace} · name is immutable
          </Text>
        }
      />

      <Alert
        color={
          !specEditable
            ? "yellow"
            : vm.restartRequired
              ? "orange"
              : guestStopped
                ? "gray"
                : "blue"
        }
        variant="light"
        title={
          <Group gap="xs" wrap="nowrap">
            <Text span size="sm" fw={600}>
              Status
            </Text>
            <StatusBadge status={vm.status} />
            <Text span size="sm" c="dimmed">
              {specEditable
                ? guestStopped
                  ? "· size & run strategy editable"
                  : "· LiveUpdate — size may apply without stop"
                : "· labels only"}
            </Text>
          </Group>
        }
      >
        {!specEditable
          ? `Cannot edit size, preference, or run strategy while status is ${vm.status}. Labels can always be updated.`
          : guestStopped
            ? "Size, preference, and run strategy can be changed while the VM is stopped. Labels can always be updated."
            : "This VM is running. Size and instance type changes use KubeVirt LiveUpdate when possible; otherwise a RestartRequired condition is set. Labels can always be updated."}
      </Alert>

      {vm.restartRequired && (
        <Alert color="orange" variant="light" title="Restart required">
          {vm.restartRequiredMessage?.trim() ||
            "A previous change is waiting on a guest reboot."}{" "}
          Soft or hard restart the VM from the detail page after saving.
        </Alert>
      )}

      {actionData && "error" in actionData && actionData.error && (
        <Alert color="red" title="Update failed" variant="light">
          {actionData.error}
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack gap="md">
          <FormSection title="Identity">
            <TextInput label="Cluster" value={vm.cluster} disabled />
            <TextInput label="Namespace" value={vm.namespace} disabled />
            <TextInput label="Name" value={vm.name} disabled />
          </FormSection>

          <FormSection title="Run strategy">
            <Select
              label="Run strategy"
              description="How KubeVirt keeps the guest running after create / failure"
              data={[...VM_RUN_STRATEGIES]}
              disabled={!specEditable}
              required={specEditable}
              {...form.getInputProps("runStrategy")}
            />
          </FormSection>

          <FormSection title="Size">
            {catalog.hasInstanceTypes ? (
              <SegmentedControl
                fullWidth
                disabled={!specEditable}
                data={[
                  { label: "Instance type", value: "instancetype" },
                  { label: "Manual", value: "manual" },
                ]}
                value={form.values.sizeMode}
                onChange={(v) =>
                  form.setFieldValue(
                    "sizeMode",
                    v === "instancetype" ? "instancetype" : "manual",
                  )
                }
              />
            ) : null}

            {form.values.sizeMode === "instancetype" && catalog.hasInstanceTypes ? (
              <Select
                label="Instance type"
                description="Grouped by common-instancetypes class"
                data={instanceTypeOptions}
                searchable
                nothingFoundMessage="No instance types match"
                disabled={!specEditable}
                required={specEditable}
                value={form.values.instanceType || null}
                error={form.errors.instanceType}
                onChange={(v) => form.setFieldValue("instanceType", v ?? "")}
              />
            ) : (
              <GroupFields>
                <NumberInput
                  label="CPU cores"
                  min={1}
                  max={256}
                  disabled={!specEditable}
                  required={specEditable}
                  {...form.getInputProps("cpuCores")}
                />
                <TextInput
                  label="Memory"
                  placeholder="4Gi"
                  disabled={!specEditable}
                  required={specEditable}
                  {...form.getInputProps("memory")}
                />
              </GroupFields>
            )}

            {(catalog.preferences.length > 0 || form.values.preference) && (
              <Select
                label="Preference"
                description="VirtualMachineClusterPreference (optional)"
                clearable
                searchable
                data={
                  preferenceOptions.length > 0
                    ? preferenceOptions
                    : form.values.preference
                      ? [form.values.preference]
                      : []
                }
                disabled={!specEditable}
                value={form.values.preference || null}
                onChange={(v) => form.setFieldValue("preference", v ?? "")}
              />
            )}
          </FormSection>

          <FormSection title="Labels">
            <Textarea
              label="Labels"
              description="One key=value per line. Always applied on save."
              minRows={6}
              autosize
              styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
              {...form.getInputProps("labelsText")}
            />
          </FormSection>

          <FormActions>
            <Button component={Link} to={vmPath(vm)} variant="default">
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

function GroupFields({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}
