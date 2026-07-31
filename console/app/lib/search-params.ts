/**
 * Pure URL search-param helpers for URL-driven view state.
 * Prefer these over local-only filter state so views are shareable/bookmarkable.
 */

/** Build `path` with a query string; empty/null/undefined values are omitted. */
export function withSearch(
  path: string,
  params: Record<string, string | null | undefined | false> = {},
): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === false) continue;
    const trimmed = String(value).trim();
    if (!trimmed) continue;
    sp.set(key, trimmed);
  }
  const q = sp.toString();
  return q ? `${path}?${q}` : path;
}

/** Read a param; empty/whitespace → null. */
export function getSearchParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)?.trim();
  return value ? value : null;
}

/** Immutable patch: null/undefined/"" deletes the key. */
export function patchSearchParams(
  current: URLSearchParams,
  patch: Record<string, string | null | undefined>,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === "") {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  return next;
}

/** Read cluster filter from a request URL (loaders). */
export function clusterFromRequest(request: Request): string | undefined {
  const url = new URL(request.url);
  return getSearchParam(url.searchParams, "cluster") ?? undefined;
}
