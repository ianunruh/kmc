import type { VmSummary } from "~/lib/types";

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

export function sizeLabel(vm: Pick<VmSummary, "cpu" | "memory">): string {
  if (vm.cpu && vm.memory) return `${vm.cpu} / ${vm.memory}`;
  if (vm.cpu) return vm.cpu;
  if (vm.memory) return vm.memory;
  return "—";
}

export function canStop(vm: Pick<VmSummary, "status">): boolean {
  return ["Running", "Starting", "Paused", "Migrating"].includes(vm.status);
}

export function canStart(vm: Pick<VmSummary, "status">): boolean {
  return ["Stopped", "Error"].includes(vm.status);
}

export function vmPath(vm: Pick<VmSummary, "cluster" | "namespace" | "name">): string {
  return `/vms/${encodeURIComponent(vm.cluster)}/${encodeURIComponent(vm.namespace)}/${encodeURIComponent(vm.name)}`;
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

export const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function validateDns1123Label(value: string): string | null {
  if (!value) return "Required";
  if (value.length > 63) return "Max 63 characters";
  if (!DNS1123_LABEL.test(value)) {
    return "DNS-1123 label required (lowercase alphanumeric and hyphens)";
  }
  return null;
}
