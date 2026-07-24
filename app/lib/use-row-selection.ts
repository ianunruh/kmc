import { useCallback, useMemo, useState } from "react";

/**
 * Multi-select state for list views (bulk actions).
 *
 * Keys are stable resource identities (e.g. `cluster/namespace/name`).
 * Pass the currently visible keys so "select all" and derived selection only
 * cover filtered rows. Selection outside the visible set is ignored until
 * those keys reappear (or Clear is used).
 */
export function useRowSelection(visibleKeys: readonly string[]) {
  const [rawSelected, setRawSelected] = useState<Set<string>>(() => new Set());

  const visibleKeySet = useMemo(() => new Set(visibleKeys), [visibleKeys]);

  /** Selected keys that are still on the visible (filtered) list. */
  const selected = useMemo(() => {
    const next = new Set<string>();
    for (const key of rawSelected) {
      if (visibleKeySet.has(key)) next.add(key);
    }
    return next;
  }, [rawSelected, visibleKeySet]);

  const selectedCount = selected.size;
  const visibleCount = visibleKeys.length;

  const allSelected =
    visibleCount > 0 && visibleKeys.every((k) => selected.has(k));
  const someSelected =
    !allSelected && visibleKeys.some((k) => selected.has(k));

  const isSelected = useCallback((key: string) => selected.has(key), [selected]);

  const toggle = useCallback((key: string) => {
    setRawSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    setRawSelected(new Set(visibleKeys));
  }, [visibleKeys]);

  const clear = useCallback(() => {
    setRawSelected(new Set());
  }, []);

  const toggleAllVisible = useCallback(() => {
    setRawSelected((prev) => {
      const allVisibleSelected =
        visibleKeys.length > 0 && visibleKeys.every((k) => prev.has(k));
      if (allVisibleSelected) return new Set();
      return new Set(visibleKeys);
    });
  }, [visibleKeys]);

  const selectedKeys = useMemo(() => Array.from(selected), [selected]);

  return {
    selected,
    selectedKeys,
    selectedCount,
    allSelected,
    someSelected,
    isSelected,
    toggle,
    selectAllVisible,
    toggleAllVisible,
    clear,
  };
}

/** Stable identity key for namespaced cluster resources. */
export function resourceKey(r: {
  cluster: string;
  namespace: string;
  name: string;
}): string {
  return `${r.cluster}/${r.namespace}/${r.name}`;
}
