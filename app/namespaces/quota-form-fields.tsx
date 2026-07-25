import {
  Checkbox,
  NumberInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import type { UseFormReturnType } from "@mantine/form";
import { isValidByteQuantity, isValidCpuQuantity } from "./quantity";

/** Shared form values for create + edit quota sections. */
export type NamespaceQuotaFormValues = {
  enableQuota: boolean;
  cpu: string;
  memory: string;
  storage: string;
  vms: number | string;
  pvcs: number | string;
};

export const DEFAULT_QUOTA_FORM: NamespaceQuotaFormValues = {
  enableQuota: false,
  cpu: "16",
  memory: "64Gi",
  storage: "500Gi",
  vms: 20,
  pvcs: 40,
};

export function validateQuotaFormFields(
  values: NamespaceQuotaFormValues,
): Partial<Record<keyof NamespaceQuotaFormValues, string>> {
  if (!values.enableQuota) return {};
  const errors: Partial<Record<keyof NamespaceQuotaFormValues, string>> = {};
  const cpu = values.cpu.trim();
  const memory = values.memory.trim();
  const storage = values.storage.trim();
  const vms = Number(values.vms);
  const pvcs = Number(values.pvcs);

  if (cpu && !isValidCpuQuantity(cpu)) {
    errors.cpu = "Use cores (16) or millicores (500m)";
  }
  if (memory && !isValidByteQuantity(memory)) {
    errors.memory = "Use a quantity like 64Gi";
  }
  if (storage && !isValidByteQuantity(storage)) {
    errors.storage = "Use a quantity like 500Gi";
  }
  if (values.vms !== "" && values.vms != null) {
    if (!Number.isFinite(vms) || vms < 0 || !Number.isInteger(vms)) {
      errors.vms = "Non-negative integer";
    }
  }
  if (values.pvcs !== "" && values.pvcs != null) {
    if (!Number.isFinite(pvcs) || pvcs < 0 || !Number.isInteger(pvcs)) {
      errors.pvcs = "Non-negative integer";
    }
  }

  const hasAny =
    Boolean(cpu) ||
    Boolean(memory) ||
    Boolean(storage) ||
    (values.vms !== "" && values.vms != null && Number.isFinite(vms)) ||
    (values.pvcs !== "" && values.pvcs != null && Number.isFinite(pvcs));
  if (!hasAny) {
    errors.cpu = "Set at least one limit";
  }
  return errors;
}

export function quotaLimitsFromForm(values: NamespaceQuotaFormValues) {
  const cpu = values.cpu.trim() || undefined;
  const memory = values.memory.trim() || undefined;
  const storage = values.storage.trim() || undefined;
  const vmsRaw = values.vms;
  const pvcsRaw = values.pvcs;
  const vms =
    vmsRaw === "" || vmsRaw == null ? undefined : Math.floor(Number(vmsRaw));
  const pvcs =
    pvcsRaw === "" || pvcsRaw == null ? undefined : Math.floor(Number(pvcsRaw));
  return {
    ...(cpu ? { cpu } : {}),
    ...(memory ? { memory } : {}),
    ...(storage ? { storage } : {}),
    ...(vms != null && Number.isFinite(vms) ? { vms } : {}),
    ...(pvcs != null && Number.isFinite(pvcs) ? { pvcs } : {}),
  };
}

export function NamespaceQuotaFormFields({
  form,
  showEnableToggle = true,
  description,
}: {
  // Accept any form that includes the quota fields (create extends them).
  form: UseFormReturnType<NamespaceQuotaFormValues>;
  showEnableToggle?: boolean;
  description?: string;
}) {
  const enabled = Boolean(form.values.enableQuota);

  return (
    <Stack gap="sm">
      {description && (
        <Text size="sm" c="dimmed">
          {description}
        </Text>
      )}
      {showEnableToggle && (
        <Checkbox
          label="Set resource quotas"
          description="Creates a ResourceQuota (kmc-quota) enforcing hard limits for this project"
          checked={enabled}
          onChange={(e) =>
            form.setFieldValue("enableQuota", e.currentTarget.checked)
          }
        />
      )}
      {enabled && (
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <TextInput
            label="CPU (requests)"
            description="Total guest CPU across virt-launcher pods"
            placeholder="16"
            {...form.getInputProps("cpu")}
          />
          <TextInput
            label="Memory (requests)"
            description="Total guest memory"
            placeholder="64Gi"
            {...form.getInputProps("memory")}
          />
          <TextInput
            label="Storage (requests)"
            description="Total PVC capacity"
            placeholder="500Gi"
            {...form.getInputProps("storage")}
          />
          <NumberInput
            label="Virtual machines"
            description="count/virtualmachines.kubevirt.io"
            min={0}
            allowDecimal={false}
            {...form.getInputProps("vms")}
          />
          <NumberInput
            label="Persistent volume claims"
            description="Volume count (root + secondary disks)"
            min={0}
            allowDecimal={false}
            {...form.getInputProps("pvcs")}
          />
        </SimpleGrid>
      )}
    </Stack>
  );
}
