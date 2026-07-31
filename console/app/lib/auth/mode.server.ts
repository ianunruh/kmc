import type { AuthMode } from "./types";

export type { AuthMode };

export function getAuthMode(): AuthMode {
  const raw = (process.env.KMC_AUTH_MODE ?? "kubeconfig").trim().toLowerCase();
  if (raw === "impersonate") return "impersonate";
  return "kubeconfig";
}

export function isImpersonateMode(): boolean {
  return getAuthMode() === "impersonate";
}
