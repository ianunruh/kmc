import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { getSearchParam, patchSearchParams } from "./search-params";

/** Standard list filter keys used across resource index pages. */
export type ListFilterKey =
  | "q"
  | "cluster"
  | "namespace"
  | "status"
  | "phase"
  | "instancetype"
  | "owner"
  | "template";

export interface ListFilters {
  /** Free-text search (URL `q`) */
  q: string;
  cluster: string | null;
  namespace: string | null;
  status: string | null;
  phase: string | null;
  /** Exact match on VM cluster instance type name */
  instancetype: string | null;
  /** Exact match on kmc.ianunruh.com/owner (GitHub login) */
  owner: string | null;
  /** Exact match on kmc.ianunruh.com/template */
  template: string | null;
}

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * URL-backed list filters
 * (`?q=&cluster=&namespace=&status=&phase=&instancetype=&owner=&template=`).
 *
 * - Discrete filters write immediately.
 * - Search uses a local draft + debounced URL update so typing stays smooth
 *   while still landing on a shareable URL.
 * - All updates use `replace: true` to avoid polluting history.
 */
export function useListFilters(options?: { debounceMs?: number }) {
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const [searchParams, setSearchParams] = useSearchParams();

  const filters: ListFilters = useMemo(
    () => ({
      q: getSearchParam(searchParams, "q") ?? "",
      cluster: getSearchParam(searchParams, "cluster"),
      namespace: getSearchParam(searchParams, "namespace"),
      status: getSearchParam(searchParams, "status"),
      phase: getSearchParam(searchParams, "phase"),
      instancetype: getSearchParam(searchParams, "instancetype"),
      owner: getSearchParam(searchParams, "owner"),
      template: getSearchParam(searchParams, "template"),
    }),
    [searchParams],
  );

  const [qDraft, setQDraft] = useState(filters.q);
  // Sync draft when the URL changes externally (back/forward, shared links).
  // Render-time adjust — https://react.dev/learn/you-might-not-need-an-effect
  const [urlQ, setUrlQ] = useState(filters.q);
  if (filters.q !== urlQ) {
    setUrlQ(filters.q);
    setQDraft(filters.q);
  }

  // Debounce draft → URL.
  useEffect(() => {
    const next = qDraft.trim();
    if (next === filters.q) return;

    const handle = window.setTimeout(() => {
      setSearchParams((prev) => patchSearchParams(prev, { q: next || null }), {
        replace: true,
      });
    }, debounceMs);

    return () => window.clearTimeout(handle);
  }, [qDraft, filters.q, debounceMs, setSearchParams]);

  const setFilter = useCallback(
    (key: Exclude<ListFilterKey, "q">, value: string | null) => {
      setSearchParams((prev) => patchSearchParams(prev, { [key]: value || null }), {
        replace: true,
      });
    },
    [setSearchParams],
  );

  const setQ = useCallback((value: string) => {
    setQDraft(value);
  }, []);

  const clearFilters = useCallback(() => {
    setQDraft("");
    setUrlQ("");
    setSearchParams(
      (prev) =>
        patchSearchParams(prev, {
          q: null,
          cluster: null,
          namespace: null,
          status: null,
          phase: null,
          instancetype: null,
          owner: null,
          template: null,
        }),
      { replace: true },
    );
  }, [setSearchParams]);

  return {
    filters,
    /** Immediate value for the search input (may lead the URL by debounceMs). */
    qDraft,
    setQ,
    setFilter,
    clearFilters,
  };
}

/** Case-insensitive substring match against any of the given fields. */
export function matchesQuery(
  q: string,
  fields: Array<string | undefined | null>,
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}
