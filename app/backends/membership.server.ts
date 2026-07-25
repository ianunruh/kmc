import type { BackendMembership } from "~/lib/types";
import {
  KMC_LABEL_TARGET_KIND,
  KMC_LABEL_VM,
  KMC_TARGET_KIND_VM,
} from "~/lib/k8s/constants";

/**
 * Resolve Service.spec.selector from membership mode.
 * Selects virt-launcher pods (KubeVirt stamps kubevirt.io/vm on them).
 */
export function resolveServiceSelector(
  membership: BackendMembership,
): Record<string, string> {
  if (membership.mode === "single-vm") {
    return { "kubevirt.io/vm": membership.vmName };
  }
  // Future modes (labels | group) extend BackendMembership and land here until handled.
  const mode = (membership as { mode: string }).mode;
  throw new Error(`Unsupported backend membership mode: ${mode}`);
}

/** Labels that record membership mode on the Service metadata. */
export function membershipLabels(
  membership: BackendMembership,
): Record<string, string> {
  if (membership.mode === "single-vm") {
    return {
      [KMC_LABEL_TARGET_KIND]: KMC_TARGET_KIND_VM,
      [KMC_LABEL_VM]: membership.vmName,
    };
  }
  const mode = (membership as { mode: string }).mode;
  throw new Error(`Unsupported backend membership mode: ${mode}`);
}

/**
 * Parse membership from Service labels (read path).
 * Unknown / missing labels → { mode: "unknown" }.
 */
export function membershipFromLabels(
  labels: Record<string, string> | undefined,
): BackendMembership | { mode: "unknown" } {
  if (!labels) return { mode: "unknown" };
  const kind = labels[KMC_LABEL_TARGET_KIND];
  const vmName = labels[KMC_LABEL_VM];
  if (kind === KMC_TARGET_KIND_VM && vmName) {
    return { mode: "single-vm", vmName };
  }
  return { mode: "unknown" };
}
