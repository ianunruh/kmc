import type { BackendMembership } from "~/lib/types";
import {
  KMC_ANN_MATCH_LABELS,
  KMC_ANN_MEMBER_VMS,
  KMC_LABEL_BACKEND_GROUP,
  KMC_LABEL_TARGET_KIND,
  KMC_LABEL_VM,
  KMC_TARGET_KIND_GROUP,
  KMC_TARGET_KIND_LABELS,
  KMC_TARGET_KIND_VM,
} from "~/lib/k8s/constants";

/**
 * Resolve Service.spec.selector from membership mode.
 * Selects virt-launcher pods (KubeVirt stamps labels from the VM pod template).
 */
export function resolveServiceSelector(
  membership: BackendMembership,
): Record<string, string> {
  switch (membership.mode) {
    case "single-vm":
      return { "kubevirt.io/vm": membership.vmName };
    case "labels":
      return { ...membership.matchLabels };
    case "group":
      return { [KMC_LABEL_BACKEND_GROUP]: membership.groupId };
    default: {
      const mode = (membership as { mode: string }).mode;
      throw new Error(`Unsupported backend membership mode: ${mode}`);
    }
  }
}

/** Labels that record membership mode on the Service metadata. */
export function membershipLabels(
  membership: BackendMembership,
): Record<string, string> {
  switch (membership.mode) {
    case "single-vm":
      return {
        [KMC_LABEL_TARGET_KIND]: KMC_TARGET_KIND_VM,
        [KMC_LABEL_VM]: membership.vmName,
      };
    case "labels":
      return {
        [KMC_LABEL_TARGET_KIND]: KMC_TARGET_KIND_LABELS,
      };
    case "group":
      return {
        [KMC_LABEL_TARGET_KIND]: KMC_TARGET_KIND_GROUP,
        [KMC_LABEL_BACKEND_GROUP]: membership.groupId,
      };
    default: {
      const mode = (membership as { mode: string }).mode;
      throw new Error(`Unsupported backend membership mode: ${mode}`);
    }
  }
}

/** Annotations that round-trip membership details not expressible as labels. */
export function membershipAnnotations(
  membership: BackendMembership,
): Record<string, string> {
  switch (membership.mode) {
    case "single-vm":
      return {};
    case "labels":
      return {
        [KMC_ANN_MATCH_LABELS]: JSON.stringify(membership.matchLabels),
      };
    case "group":
      return {
        [KMC_ANN_MEMBER_VMS]: membership.vmNames.join(","),
      };
    default:
      return {};
  }
}

/**
 * Parse membership from Service labels + annotations (read path).
 * Unknown / missing labels → { mode: "unknown" }.
 */
export function membershipFromServiceMeta(
  labels: Record<string, string> | undefined,
  annotations: Record<string, string> | undefined,
): BackendMembership | { mode: "unknown" } {
  if (!labels) return { mode: "unknown" };
  const kind = labels[KMC_LABEL_TARGET_KIND];

  if (kind === KMC_TARGET_KIND_VM) {
    const vmName = labels[KMC_LABEL_VM];
    if (vmName) return { mode: "single-vm", vmName };
    return { mode: "unknown" };
  }

  if (kind === KMC_TARGET_KIND_LABELS) {
    const raw = annotations?.[KMC_ANN_MATCH_LABELS];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const matchLabels: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof k === "string" && typeof v === "string") {
              matchLabels[k] = v;
            }
          }
          if (Object.keys(matchLabels).length > 0) {
            return { mode: "labels", matchLabels };
          }
        }
      } catch {
        // fall through
      }
    }
    return { mode: "unknown" };
  }

  if (kind === KMC_TARGET_KIND_GROUP) {
    const groupId = labels[KMC_LABEL_BACKEND_GROUP];
    if (!groupId) return { mode: "unknown" };
    const raw = annotations?.[KMC_ANN_MEMBER_VMS] ?? "";
    const vmNames = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { mode: "group", groupId, vmNames };
  }

  return { mode: "unknown" };
}

/** True if every selector entry is present with the same value on labels. */
export function labelsMatchSelector(
  labels: Record<string, string> | undefined,
  selector: Record<string, string>,
): boolean {
  if (!selector || Object.keys(selector).length === 0) return false;
  const l = labels ?? {};
  for (const [k, v] of Object.entries(selector)) {
    if (l[k] !== v) return false;
  }
  return true;
}

export function singleVmMembership(vmName: string): BackendMembership {
  return { mode: "single-vm", vmName };
}

export function labelsMembership(
  matchLabels: Record<string, string>,
): BackendMembership {
  return { mode: "labels", matchLabels };
}

export function groupMembership(
  groupId: string,
  vmNames: string[],
): BackendMembership {
  return {
    mode: "group",
    groupId,
    vmNames: [...new Set(vmNames.map((n) => n.trim()).filter(Boolean))].sort(),
  };
}

/**
 * Parse `key=value` lines (newline or comma separated) into a label map.
 */
export function parseMatchLabelsText(text: string): Record<string, string> {
  const matchLabels: Record<string, string> = {};
  const parts = text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `Invalid label "${part}" — expected key=value (one per line or comma-separated)`,
      );
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key || !value) {
      throw new Error(`Invalid label "${part}" — empty key or value`);
    }
    if (/\s/.test(key)) {
      throw new Error(`Invalid label key "${key}" — must not contain spaces`);
    }
    matchLabels[key] = value;
  }
  if (Object.keys(matchLabels).length === 0) {
    throw new Error("At least one match label is required");
  }
  return matchLabels;
}
