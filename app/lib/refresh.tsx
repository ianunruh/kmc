import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRevalidator } from "react-router";

const STORAGE_KEY = "kmc.auto-refresh";
export const AUTO_REFRESH_INTERVAL_SEC = 10;

type RefreshContextValue = {
  /** Auto-refresh enabled (persisted in localStorage). */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** Seconds until the next automatic revalidate (when enabled). */
  secondsLeft: number;
  intervalSec: number;
  /** True while React Router is revalidating loaders. */
  isRefreshing: boolean;
  /** Epoch ms of last completed revalidation, if any. */
  lastRefreshedAt: number | null;
  /** Trigger an immediate revalidation and reset the countdown. */
  refreshNow: () => void;
};

const RefreshContext = createContext<RefreshContextValue | null>(null);

function readStoredEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function RefreshProvider({ children }: { children: ReactNode }) {
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  const [enabled, setEnabledState] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(AUTO_REFRESH_INTERVAL_SEC);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const prevState = useRef(revalidator.state);

  // Avoid SSR/client mismatch: load preference after mount.
  useEffect(() => {
    setEnabledState(readStoredEnabled());
    setHydrated(true);
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
    } catch {
      // ignore quota / private mode
    }
    if (next) {
      setSecondsLeft(AUTO_REFRESH_INTERVAL_SEC);
    }
  }, []);

  // Mark last refresh when a revalidation finishes.
  useEffect(() => {
    if (prevState.current !== "idle" && revalidator.state === "idle") {
      setLastRefreshedAt(Date.now());
    }
    prevState.current = revalidator.state;
  }, [revalidator.state]);

  // Global auto-refresh clock (single owner for the whole app).
  useEffect(() => {
    if (!hydrated || !enabled) return;

    setSecondsLeft(AUTO_REFRESH_INTERVAL_SEC);
    const id = window.setInterval(() => {
      const rv = revalidatorRef.current;
      if (rv.state !== "idle") return;

      setSecondsLeft((left) => {
        if (left <= 1) {
          rv.revalidate();
          return AUTO_REFRESH_INTERVAL_SEC;
        }
        return left - 1;
      });
    }, 1000);

    return () => window.clearInterval(id);
  }, [enabled, hydrated]);

  const refreshNow = useCallback(() => {
    const rv = revalidatorRef.current;
    if (rv.state === "idle") {
      rv.revalidate();
    }
    setSecondsLeft(AUTO_REFRESH_INTERVAL_SEC);
  }, []);

  const value = useMemo<RefreshContextValue>(
    () => ({
      enabled: hydrated ? enabled : true,
      setEnabled,
      secondsLeft: enabled ? secondsLeft : AUTO_REFRESH_INTERVAL_SEC,
      intervalSec: AUTO_REFRESH_INTERVAL_SEC,
      isRefreshing: revalidator.state !== "idle",
      lastRefreshedAt,
      refreshNow,
    }),
    [
      hydrated,
      enabled,
      setEnabled,
      secondsLeft,
      revalidator.state,
      lastRefreshedAt,
      refreshNow,
    ],
  );

  return (
    <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>
  );
}

export function useRefresh(): RefreshContextValue {
  const ctx = useContext(RefreshContext);
  if (!ctx) {
    throw new Error("useRefresh must be used within RefreshProvider");
  }
  return ctx;
}
