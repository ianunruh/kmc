import type { VmSummary } from "~/lib/types";
import { withSearch } from "./search-params";

/** Accept ISO strings or Date (core/v1 client-node + turbo-stream). */
function parseTimestamp(value: string | Date | undefined | null): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatAge(iso: string | Date): string {
  const d = parseTimestamp(iso);
  if (!d) return iso instanceof Date ? "—" : iso || "—";
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

export function formatDateTime(iso?: string | Date): string {
  const d = parseTimestamp(iso);
  if (!d) return "—";
  return d.toLocaleString();
}

/** Always `cpu / memory` (em dash when a side is unknown). */
export function sizeLabel(vm: Pick<VmSummary, "cpu" | "memory">): string {
  return `${vm.cpu ?? "—"} / ${vm.memory ?? "—"}`;
}

/** Human-readable byte sizes for guest filesystem usage, etc. */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

/**
 * Hard stop. Paused is excluded — modern KubeVirt rejects stop until unpaused.
 */
export function canStop(vm: Pick<VmSummary, "status">): boolean {
  return ["Running", "Starting", "Migrating"].includes(vm.status);
}

export function canStart(vm: Pick<VmSummary, "status">): boolean {
  return ["Stopped", "Error"].includes(vm.status);
}

/** Hard restart via VM subresource (tears down the domain). */
export function canRestart(vm: Pick<VmSummary, "status">): boolean {
  return ["Running", "Paused"].includes(vm.status);
}

/**
 * ACPI soft reboot via VMI subresource (needs a Running guest; guest agent
 * preferred but not required by the API).
 */
export function canSoftReboot(vm: Pick<VmSummary, "status">): boolean {
  return vm.status === "Running";
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
 * Size, preference, and runStrategy can be edited when the guest is down, or
 * while it is running (LiveUpdate — default on modern KubeVirt). Changes that
 * cannot apply live surface as RestartRequired on the VM.
 */
export function canEditVmSpec(vm: Pick<VmSummary, "status">): boolean {
  return ["Stopped", "Error", "Running", "Paused", "Migrating"].includes(vm.status);
}

/** True when the guest is not running — useful for messaging vs LiveUpdate. */
export function isVmStopped(vm: Pick<VmSummary, "status">): boolean {
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

/** Common detail subpages (overview is the bare resource URL). */
export type DetailSubTab = "overview" | "access" | "events" | "yaml";

/** Append a detail tab segment to a resource path (`overview` → base). */
export function detailTabPath(base: string, tab: string = "overview"): string {
  if (!tab || tab === "overview") return base;
  return `${base}/${tab}`;
}

export type VmDetailTab = "overview" | "networking" | "storage" | "events" | "yaml";

/** Tab subpages under the VM detail layout (overview is the index URL). */
export function vmTabPath(
  vm: Pick<VmSummary, "cluster" | "namespace" | "name">,
  tab: VmDetailTab = "overview",
): string {
  return detailTabPath(vmPath(vm), tab);
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

/** Browser SSH terminal (platform key + KubeVirt port-forward). */
export function vmTerminalPath(
  vm: Pick<VmSummary, "cluster" | "namespace" | "name">,
): string {
  return `${vmPath(vm)}/terminal`;
}

export function dataVolumePath(
  dv: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `/datavolumes/${encodeURIComponent(dv.cluster)}/${encodeURIComponent(dv.namespace)}/${encodeURIComponent(dv.name)}`;
}

export function databasePath(
  db: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `/databases/${encodeURIComponent(db.cluster)}/${encodeURIComponent(db.namespace)}/${encodeURIComponent(db.name)}`;
}

/** Browser psql terminal (pod exec as app user on the primary). */
export function databaseTerminalPath(
  db: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `${databasePath(db)}/terminal`;
}

/**
 * psql terminal needs a live primary (or at least one ready instance).
 * Status "Ready" alone is enough when status fields lag.
 */
export function canOpenDatabaseTerminal(
  db: Pick<
    {
      status: string;
      readyInstances?: number;
      currentPrimary?: string;
    },
    "status" | "readyInstances" | "currentPrimary"
  >,
): boolean {
  if (db.currentPrimary?.trim()) return true;
  if ((db.readyInstances ?? 0) > 0) return true;
  return db.status === "Ready";
}

export function databasesListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
    namespace?: string | null;
    status?: string | null;
  } = {},
): string {
  return withSearch("/databases", filters);
}

export function databaseCreatePath(
  prefill: {
    cluster?: string | null;
    namespace?: string | null;
    name?: string | null;
  } = {},
): string {
  return withSearch("/databases/create", prefill);
}

export function objectStoragePath(
  bucket: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `/object-storage/${encodeURIComponent(bucket.cluster)}/${encodeURIComponent(bucket.namespace)}/${encodeURIComponent(bucket.name)}`;
}

export function objectStorageListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
    namespace?: string | null;
    status?: string | null;
  } = {},
): string {
  return withSearch("/object-storage", filters);
}

export function objectStorageCreatePath(
  prefill: {
    cluster?: string | null;
    namespace?: string | null;
    name?: string | null;
  } = {},
): string {
  return withSearch("/object-storage/create", prefill);
}

/** Snapshot is restorable when Ready and readyToUse. */
export function canRestoreVmSnapshot(
  snap: Pick<{ phase: string; readyToUse: boolean }, "phase" | "readyToUse">,
): boolean {
  return snap.readyToUse === true && snap.phase !== "Failed";
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

export function imagePath(
  img: Pick<{ cluster: string; name: string }, "cluster" | "name">,
): string {
  return `/images/${encodeURIComponent(img.cluster)}/${encodeURIComponent(img.name)}`;
}

export function imageEditPath(
  img: Pick<{ cluster: string; name: string }, "cluster" | "name">,
): string {
  return `${imagePath(img)}/edit`;
}

export function imagesListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
    phase?: string | null;
  } = {},
): string {
  return withSearch("/images", filters);
}

/** Launch VM prefilled with a golden image (`namespace/name` or bare name). */
export function vmCreateFromImagePath(img: {
  cluster: string;
  name: string;
  namespace?: string;
}): string {
  const ns = img.namespace?.trim();
  const image = ns ? `${ns}/${img.name}` : img.name;
  return withSearch("/vms/create", {
    cluster: img.cluster,
    image,
  });
}

export function instanceTypesListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
  } = {},
): string {
  return withSearch("/instancetypes", filters);
}

export function httpRoutePath(
  route: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `/http-routes/${encodeURIComponent(route.cluster)}/${encodeURIComponent(route.namespace)}/${encodeURIComponent(route.name)}`;
}

export function httpRouteEditPath(
  route: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `${httpRoutePath(route)}/edit`;
}

/** Absolute http(s) URL for an HTTPRoute host based on parent Gateway listeners. */
export function httpRouteHostUrl(
  host: string,
  httpsHosts: readonly string[] | undefined,
): string {
  const h = host.trim();
  const scheme = httpsHosts?.includes(h) ? "https" : "http";
  return `${scheme}://${h}`;
}

export function httpRoutesListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
    namespace?: string | null;
    host?: string | null;
  } = {},
): string {
  return withSearch("/http-routes", filters);
}

export function httpRouteCreatePath(
  prefill: {
    cluster?: string | null;
    namespace?: string | null;
    vmName?: string | null;
    name?: string | null;
    host?: string | null;
    /** Existing backend Service name (expose-existing). */
    existingService?: string | null;
  } = {},
): string {
  return withSearch("/http-routes/create", prefill);
}

export function loadBalancerPath(
  lb: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `/load-balancers/${encodeURIComponent(lb.cluster)}/${encodeURIComponent(lb.namespace)}/${encodeURIComponent(lb.name)}`;
}

export function loadBalancerEditPath(
  lb: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `${loadBalancerPath(lb)}/edit`;
}

export function loadBalancersListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
    namespace?: string | null;
  } = {},
): string {
  return withSearch("/load-balancers", filters);
}

export function loadBalancerCreatePath(
  prefill: {
    cluster?: string | null;
    namespace?: string | null;
    vmName?: string | null;
    name?: string | null;
    servicePort?: string | number | null;
    targetPort?: string | number | null;
    protocol?: string | null;
  } = {},
): string {
  return withSearch("/load-balancers/create", {
    ...prefill,
    servicePort:
      prefill.servicePort != null && prefill.servicePort !== ""
        ? String(prefill.servicePort)
        : null,
    targetPort:
      prefill.targetPort != null && prefill.targetPort !== ""
        ? String(prefill.targetPort)
        : null,
  });
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

/** Create a shared router pre-attached to this VPC. */
export function vpcRouterCreatePath(
  vpc: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return withSearch("/routers/create", {
    cluster: vpc.cluster,
    namespace: vpc.namespace,
    vpc: vpc.name,
  });
}

export function routerPath(
  router: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `/routers/${encodeURIComponent(router.cluster)}/${encodeURIComponent(router.namespace)}/${encodeURIComponent(router.name)}`;
}

export function routersListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
    namespace?: string | null;
  } = {},
): string {
  return withSearch("/routers", filters);
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

export function floatingIpsListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
    namespace?: string | null;
    vpc?: string | null;
    /** associated | held */
    state?: string | null;
  } = {},
): string {
  return withSearch("/floating-ips", filters);
}

export function floatingIpPath(
  fip: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `/floating-ips/${encodeURIComponent(fip.cluster)}/${encodeURIComponent(fip.namespace)}/${encodeURIComponent(fip.name)}`;
}

/** Prefer CR name (`id`); fall back to public address for legacy rows. */
export function floatingIpDetailPath(
  fip: Pick<
    {
      cluster: string;
      namespace: string;
      id?: string;
      name?: string;
      public?: string;
    },
    "cluster" | "namespace" | "id" | "name" | "public"
  >,
): string {
  const name = (fip.name || fip.id || fip.public || "").trim();
  return floatingIpPath({
    cluster: fip.cluster,
    namespace: fip.namespace,
    name,
  });
}

export function floatingIpCreatePath(
  prefill: {
    cluster?: string | null;
    namespace?: string | null;
    vpc?: string | null;
    targetVm?: string | null;
    /** Prefer a held public address when re-associating. */
    publicIpv4?: string | null;
    /** `associate` (default) or `reserve` (hold without private mapping). */
    mode?: "associate" | "reserve" | null;
  } = {},
): string {
  return withSearch("/floating-ips/create", prefill);
}

export function portForwardsListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
    namespace?: string | null;
    vpc?: string | null;
  } = {},
): string {
  return withSearch("/port-forwards", filters);
}

export function portForwardPath(
  pf: Pick<
    { cluster: string; namespace: string; name: string },
    "cluster" | "namespace" | "name"
  >,
): string {
  return `/port-forwards/${encodeURIComponent(pf.cluster)}/${encodeURIComponent(pf.namespace)}/${encodeURIComponent(pf.name)}`;
}

export function portForwardDetailPath(
  pf: Pick<
    { cluster: string; namespace: string; id?: string; name?: string },
    "cluster" | "namespace" | "id" | "name"
  >,
): string {
  const name = (pf.name || pf.id || "").trim();
  return portForwardPath({
    cluster: pf.cluster,
    namespace: pf.namespace,
    name,
  });
}

export function portForwardCreatePath(
  prefill: {
    cluster?: string | null;
    namespace?: string | null;
    vpc?: string | null;
    targetVm?: string | null;
    publicIpv4?: string | null;
    publicPort?: string | number | null;
    privatePort?: string | number | null;
    protocol?: string | null;
  } = {},
): string {
  return withSearch("/port-forwards/create", {
    ...prefill,
    publicPort:
      prefill.publicPort != null && prefill.publicPort !== ""
        ? String(prefill.publicPort)
        : null,
    privatePort:
      prefill.privatePort != null && prefill.privatePort !== ""
        ? String(prefill.privatePort)
        : null,
  });
}

export function namespacePath(
  ns: Pick<{ cluster: string; name: string }, "cluster" | "name">,
): string {
  return `/namespaces/${encodeURIComponent(ns.cluster)}/${encodeURIComponent(ns.name)}`;
}

export function namespaceEditPath(
  ns: Pick<{ cluster: string; name: string }, "cluster" | "name">,
): string {
  return `${namespacePath(ns)}/edit`;
}

export function namespacesListPath(
  filters: {
    q?: string | null;
    cluster?: string | null;
  } = {},
): string {
  return withSearch("/namespaces", filters);
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

/** Max VMs per multi-launch from the create form. */
export const MAX_VM_LAUNCH_COUNT = 50;

/**
 * Expand a base VM name into one or more DNS-1123 names for multi-launch.
 * count === 1 → [base] as-is; count > 1 → base-1 … base-N.
 */
export function expandVmLaunchNames(
  baseName: string,
  count: number,
): { names: string[] } | { error: string } {
  const base = baseName.trim();
  if (!base) return { error: "Name is required" };
  if (!Number.isInteger(count) || count < 1) {
    return { error: "Count must be a positive integer" };
  }
  if (count > MAX_VM_LAUNCH_COUNT) {
    return { error: `Count cannot exceed ${MAX_VM_LAUNCH_COUNT}` };
  }

  if (count === 1) {
    const err = validateDns1123Label(base);
    if (err) return { error: err === "Required" ? "Name is required" : err };
    return { names: [base] };
  }

  const names: string[] = [];
  for (let i = 1; i <= count; i++) {
    const name = `${base}-${i}`;
    const err = validateDns1123Label(name);
    if (err) {
      if (name.length > 63) {
        return {
          error: `Generated name “${name}” exceeds 63 characters — shorten the base name`,
        };
      }
      return {
        error: `Generated name “${name}” is not a valid DNS-1123 label — adjust the base name`,
      };
    }
    names.push(name);
  }
  return { names };
}
