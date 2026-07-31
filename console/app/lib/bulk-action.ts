import { formatError } from "~/lib/errors";
import type {
  BulkActionResult,
  BulkActionSummary,
  BulkClusterTarget,
  BulkItemResult,
  BulkResourceTarget,
} from "~/lib/types";

/** Max targets accepted in one bulk POST. */
export const BULK_TARGET_LIMIT = 100;

export function isBulkActionResult(data: unknown): data is BulkActionResult {
  if (data == null || typeof data !== "object") return false;
  const d = data as BulkActionResult;
  return (
    d.summary != null &&
    typeof d.intent === "string" &&
    d.intent.startsWith("bulk-") &&
    Array.isArray(d.results)
  );
}

export function summarizeBulkResults(
  results: BulkItemResult[],
): BulkActionSummary {
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "ok") succeeded += 1;
    else if (r.status === "skipped") skipped += 1;
    else failed += 1;
  }
  return { total: results.length, succeeded, skipped, failed };
}

function parseTargetArray(raw: FormDataEntryValue | null): {
  items?: unknown[];
  error?: string;
} {
  if (raw == null || String(raw).trim() === "") {
    return { error: "Missing targets" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { error: "Invalid targets JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { error: "Targets must be an array" };
  }
  if (parsed.length === 0) {
    return { error: "No targets selected" };
  }
  if (parsed.length > BULK_TARGET_LIMIT) {
    return { error: `Too many targets (max ${BULK_TARGET_LIMIT})` };
  }
  return { items: parsed };
}

function field(obj: object, name: string): string {
  return String((obj as Record<string, unknown>)[name] ?? "").trim();
}

/** Parse namespaced targets: cluster / namespace / name. */
export function parseNamespacedBulkTargets(raw: FormDataEntryValue | null): {
  targets?: BulkResourceTarget[];
  error?: string;
} {
  const { items, error } = parseTargetArray(raw);
  if (error || !items) return { error: error ?? "Missing targets" };

  const targets: BulkResourceTarget[] = [];
  for (const item of items) {
    if (item == null || typeof item !== "object") {
      return { error: "Each target must be an object" };
    }
    const cluster = field(item, "cluster");
    const namespace = field(item, "namespace");
    const name = field(item, "name");
    if (!cluster || !namespace || !name) {
      return { error: "Each target needs cluster, namespace, and name" };
    }
    targets.push({ cluster, namespace, name });
  }
  return { targets };
}

/** Parse cluster-scoped targets: cluster / name. */
export function parseClusterBulkTargets(raw: FormDataEntryValue | null): {
  targets?: BulkClusterTarget[];
  error?: string;
} {
  const { items, error } = parseTargetArray(raw);
  if (error || !items) return { error: error ?? "Missing targets" };

  const targets: BulkClusterTarget[] = [];
  for (const item of items) {
    if (item == null || typeof item !== "object") {
      return { error: "Each target must be an object" };
    }
    const cluster = field(item, "cluster");
    const name = field(item, "name");
    if (!cluster || !name) {
      return { error: "Each target needs cluster and name" };
    }
    targets.push({ cluster, name });
  }
  return { targets };
}

/** Parse id-only targets (e.g. SSH keys). */
export function parseIdBulkTargets(raw: FormDataEntryValue | null): {
  targets?: Array<{ id: string }>;
  error?: string;
} {
  const { items, error } = parseTargetArray(raw);
  if (error || !items) return { error: error ?? "Missing targets" };

  const targets: Array<{ id: string }> = [];
  for (const item of items) {
    if (item == null || typeof item !== "object") {
      return { error: "Each target must be an object" };
    }
    const id = field(item, "id");
    if (!id) return { error: "Each target needs id" };
    targets.push({ id });
  }
  return { targets };
}

/** Parse floating-IP targets. */
export function parseFloatingIpBulkTargets(raw: FormDataEntryValue | null): {
  targets?: Array<{
    cluster: string;
    namespace: string;
    vpcName: string;
    idOrPublic: string;
  }>;
  error?: string;
} {
  const { items, error } = parseTargetArray(raw);
  if (error || !items) return { error: error ?? "Missing targets" };

  const targets: Array<{
    cluster: string;
    namespace: string;
    vpcName: string;
    idOrPublic: string;
  }> = [];
  for (const item of items) {
    if (item == null || typeof item !== "object") {
      return { error: "Each target must be an object" };
    }
    const cluster = field(item, "cluster");
    const namespace = field(item, "namespace");
    const vpcName = field(item, "vpcName");
    const idOrPublic = field(item, "idOrPublic") || field(item, "id");
    if (!cluster || !namespace || !vpcName || !idOrPublic) {
      return {
        error: "Each target needs cluster, namespace, vpcName, and idOrPublic",
      };
    }
    targets.push({ cluster, namespace, vpcName, idOrPublic });
  }
  return { targets };
}

/**
 * Fan-out a bulk mutation sequentially. Partial success is normal —
 * each target becomes an ok/failed result.
 */
export async function runBulkAction<T>(
  intent: string,
  targets: T[],
  keyOf: (target: T) => string,
  run: (target: T) => Promise<{ retainedDisks?: string[] } | void>,
  extra?: Partial<Pick<BulkActionResult, "retainDisks">>,
): Promise<BulkActionResult> {
  const results: BulkItemResult[] = [];

  for (const t of targets) {
    const key = keyOf(t);
    try {
      const out = await run(t);
      results.push({
        key,
        status: "ok",
        retainedDisks: out?.retainedDisks,
      });
    } catch (err) {
      results.push({
        key,
        status: "failed",
        error: formatError(err),
      });
    }
  }

  const summary = summarizeBulkResults(results);
  return {
    ok: summary.failed === 0,
    intent,
    summary,
    results,
    ...extra,
  };
}

/** Encode targets for fetcher.submit form data. */
export function bulkTargetsJson(targets: unknown[]): string {
  return JSON.stringify(targets);
}

export function namespacedKey(t: {
  cluster: string;
  namespace: string;
  name: string;
}): string {
  return `${t.cluster}/${t.namespace}/${t.name}`;
}

export function clusterScopedKey(t: { cluster: string; name: string }): string {
  return `${t.cluster}/${t.name}`;
}
