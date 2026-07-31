/**
 * Kubernetes quantity helpers for ResourceQuota used/hard comparison.
 * Supports the subset we display: CPU (cores/m), memory/storage (binary + decimal),
 * and plain integer counts.
 */

import type { NamespaceQuotaUnitKind } from "~/lib/types";

/** Parse a Kubernetes quantity string into a dimensionless base unit value. */
export function parseQuantity(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Integer / decimal with optional binary or SI suffix (and millicores `m`).
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))([eE][+-]?\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|K|M|G|T|P|E|m)?$/.exec(
    s,
  );
  if (!m) return null;

  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2]) {
    const exp = Number(m[2].slice(1));
    if (!Number.isFinite(exp)) return null;
    n *= 10 ** exp;
  }

  const suffix = m[3] ?? "";
  const mult = SUFFIX_MULTIPLIERS[suffix];
  if (mult == null && suffix !== "") return null;
  return n * (mult ?? 1);
}

const SUFFIX_MULTIPLIERS: Record<string, number> = {
  // millicores / milli-units
  m: 0.001,
  // binary
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
  // decimal SI (Kubernetes also accepts k)
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

/**
 * used/hard → percent in [0, 100+]. Returns null when either side is missing
 * or unparseable, or when hard is zero.
 */
export function quantityPercent(
  used: string | undefined | null,
  hard: string | undefined | null,
): number | null {
  const u = parseQuantity(used);
  const h = parseQuantity(hard);
  if (u == null || h == null || h <= 0) return null;
  return (u / h) * 100;
}

/** True when `value` is a valid non-negative Kubernetes quantity string. */
export function isValidQuantity(value: string): boolean {
  const n = parseQuantity(value);
  return n != null && n >= 0;
}

/** Memory/storage style quantity (requires a unit suffix, or plain 0). */
export function isValidByteQuantity(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  if (s === "0") return true;
  if (!/(Ki|Mi|Gi|Ti|Pi|Ei|k|K|M|G|T|P|E)$/.test(s)) return false;
  return isValidQuantity(s);
}

/** CPU quantity: cores (`2`, `1.5`) or millicores (`500m`). */
export function isValidCpuQuantity(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  return isValidQuantity(s);
}

/**
 * Format a ResourceQuota quantity for the capacity UI.
 * status.used for memory/storage is often raw integer bytes; hard may be `64Gi`.
 * CPU may be millicores (`1500m`) or whole cores.
 */
export function formatQuotaQuantity(
  raw: string | undefined | null,
  unitKind: NamespaceQuotaUnitKind,
  empty = "—",
): string {
  if (raw == null || String(raw).trim() === "") return empty;
  const s = String(raw).trim();
  const n = parseQuantity(s);
  if (n == null) return s;

  switch (unitKind) {
    case "memory":
    case "storage":
      return formatBinaryBytes(n);
    case "cpu":
      return formatCpuCores(n);
    case "count":
      return Number.isInteger(n) ? String(n) : String(Math.round(n));
    default:
      // Prefer a compact byte-ish form when the raw value looks like bare bytes.
      if (!/[a-zA-Z]/.test(s) && n >= 1024) return formatBinaryBytes(n);
      return s;
  }
}

/** Format a core count (already parsed: 1 = one core, 0.5 = 500m). */
function formatCpuCores(cores: number): string {
  if (cores === 0) return "0";
  if (cores < 0.01) return `${Math.round(cores * 1000)}m`;
  if (cores < 1) {
    const m = Math.round(cores * 1000);
    // Prefer millicores when it stays integer-ish
    if (Math.abs(cores * 1000 - m) < 0.5) return `${m}m`;
  }
  if (Number.isInteger(cores)) return String(cores);
  // Trim trailing zeros: 1.5 → "1.5", 1.250 → "1.25"
  const fixed = cores.toFixed(3).replace(/\.?0+$/, "");
  return fixed;
}

/** Binary byte units matching k8s-style Ki/Mi/Gi (compact, no "B" suffix). */
function formatBinaryBytes(bytes: number): string {
  if (bytes === 0) return "0";
  const abs = Math.abs(bytes);
  const units = [
    { suffix: "Ei", div: 1024 ** 6 },
    { suffix: "Pi", div: 1024 ** 5 },
    { suffix: "Ti", div: 1024 ** 4 },
    { suffix: "Gi", div: 1024 ** 3 },
    { suffix: "Mi", div: 1024 ** 2 },
    { suffix: "Ki", div: 1024 },
  ] as const;

  for (const { suffix, div } of units) {
    if (abs >= div) {
      const v = bytes / div;
      // Prefer whole units when close (1073741824 → 1Gi, not 1.00Gi)
      if (Math.abs(v - Math.round(v)) < 1e-9) {
        return `${Math.round(v)}${suffix}`;
      }
      const digits = v >= 10 ? 1 : 2;
      const rounded = Number(v.toFixed(digits));
      // Drop trailing zeros after toFixed
      return `${String(rounded)}${suffix}`;
    }
  }
  return `${Math.round(bytes)}`;
}
