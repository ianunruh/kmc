import type { VmSummary } from "~/lib/types";
import { withSearch } from "./search-params";

export function formatAge(iso: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

export function formatDateTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/** Always `cpu / memory` (em dash when a side is unknown). */
export function sizeLabel(vm: Pick<VmSummary, "cpu" | "memory">): string {
  return `${vm.cpu ?? "—"} / ${vm.memory ?? "—"}`;
}

export function canStop(vm: Pick<VmSummary, "status">): boolean {
  return ["Running", "Starting", "Paused", "Migrating"].includes(vm.status);
}

export function canStart(vm: Pick<VmSummary, "status">): boolean {
  return ["Stopped", "Error"].includes(vm.status);
}

/** Soft restart via KubeVirt VM subresource (needs a live guest). */
export function canRestart(vm: Pick<VmSummary, "status">): boolean {
  return ["Running", "Paused"].includes(vm.status);
}

/** Freeze guest CPU/IO; requires a Running VMI. */
export function canPause(vm: Pick<VmSummary, "status">): boolean {
  return vm.status === "Running";
}

export function canUnpause(vm: Pick<VmSummary, "status">): boolean {
  return vm.status === "Paused";
}

/** Serial/VNC console needs a live VMI (virt-handler socket). */
export function canOpenConsole(vm: Pick<VmSummary, "status">): boolean {
  return ["Running", "Paused", "Migrating"].includes(vm.status);
}

/**
 * Size, preference, and runStrategy are only safe to change while the guest
 * is down (KubeVirt applies most template changes on the next start).
 */
export function canEditVmSpec(vm: Pick<VmSummary, "status">): boolean {
  return ["Stopped", "Error"].includes(vm.status);
}

/** Parse guest cores from a summary label like `2c`. */
export function parseCpuCores(cpu?: string): number {
  if (!cpu) return 1;
  const match = /^(\d+)/.exec(cpu.trim());
  if (!match) return 1;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Serialize labels for a textarea (`key=value` per line). */
export function formatLabelsText(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/**
 * Parse `key=value` lines into a label map.
 * Blank lines and lines starting with `#` are ignored.
 */
export function parseLabelsText(text: string): {
  labels?: Record<string, string>;
  error?: string;
} {
  const labels: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw || raw.startsWith("#")) continue;
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      return { error: `Line ${i + 1}: expected key=value` };
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1);
    if (!key) {
      return { error: `Line ${i + 1}: empty label key` };
    }
    if (key.length > 253) {
      return { error: `Line ${i + 1}: key too long` };
    }
    if (value.length > 63) {
      return { error: `Line ${i + 1}: value too long (max 63)` };
    }
    labels[key] = value;
  }
  return { labels };
}

export function vmPath(vm: Pick<VmSummary, "cluster" | "namespace" | "name">): string {
  return `/vms/${encodeURIComponent(vm.cluster)}/${encodeURIComponent(vm.namespace)}/${encodeURIComponent(vm.name)}`;
}

export function vmEditPath(
  vm: Pick<VmSummary, "cluster" | "namespace" | "name">,
): string {
  return `${vmPath(vm)}/edit`;
}

export function vmConsolePath(
  vm: Pick<VmSummary, "cluster" | "namespace" | "name">,
): string {
  return `${vmPath(vm)}/console`;
}

export function dataVolumePath(
  dv: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `/datavolumes/${encodeURIComponent(dv.cluster)}/${encodeURIComponent(dv.namespace)}/${encodeURIComponent(dv.name)}`;
}

export function instanceTypePath(
  it: Pick<{ cluster: string; name: string }, "cluster" | "name">,
): string {
  return `/instancetypes/${encodeURIComponent(it.cluster)}/${encodeURIComponent(it.name)}`;
}

export function instanceTypeEditPath(
  it: Pick<{ cluster: string; name: string }, "cluster" | "name">,
): string {
  return `${instanceTypePath(it)}/edit`;
}

/** List paths with optional URL-driven filters (shareable views). */
export function vmsListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
    namespace?: string | null;
    status?: string | null;
    instancetype?: string | null;
  } = {},
): string {
  return withSearch("/", filters);
}

export function dataVolumesListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
    namespace?: string | null;
    phase?: string | null;
  } = {},
): string {
  return withSearch("/datavolumes", filters);
}

export function instanceTypesListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
  } = {},
): string {
  return withSearch("/instancetypes", filters);
}

export function ingressPath(
  ing: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `/ingresses/${encodeURIComponent(ing.cluster)}/${encodeURIComponent(ing.namespace)}/${encodeURIComponent(ing.name)}`;
}

export function ingressesListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
    namespace?: string | null;
    host?: string | null;
  } = {},
): string {
  return withSearch("/ingresses", filters);
}

export function vpcPath(
  vpc: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `/vpcs/${encodeURIComponent(vpc.cluster)}/${encodeURIComponent(vpc.namespace)}/${encodeURIComponent(vpc.name)}`;
}

export function vpcEditPath(
  vpc: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `${vpcPath(vpc)}/edit`;
}

export function vpcsListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
    namespace?: string | null;
  } = {},
): string {
  return withSearch("/vpcs", filters);
}

export function topologyPath(
  filters: {
    cluster?: string | null;
    namespace?: string | null;
  } = {},
): string {
  return withSearch("/topology", filters);
}

export const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function validateDns1123Label(value: string): string | null {
  if (!value) return "Required";
  if (value.length > 63) return "Max 63 characters";
  if (!DNS1123_LABEL.test(value)) {
    return "DNS-1123 label required (lowercase alphanumeric and hyphens)";
  }
  return null;
}
