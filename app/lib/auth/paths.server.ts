/**
 * React Router data requests use paths like `/login.data` or `/vms/create.data`.
 * Auth and chrome need to treat those as the underlying route.
 */
export function appPathname(pathname: string): string {
  return pathname.replace(/\.data$/, "");
}

const PUBLIC_PREFIXES = ["/auth/"];
const PUBLIC_EXACT = new Set(["/login"]);

export function isPublicPath(pathname: string): boolean {
  const path = appPathname(pathname);
  if (PUBLIC_EXACT.has(path)) return true;
  return PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * Safe post-login redirect target. Rejects open redirects, auth pages, and
 * RR `.data` resource URLs (those re-trigger middleware and nest returnTo).
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw) return "/";
  let value = raw;
  try {
    value = decodeURIComponent(value);
  } catch {
    return "/";
  }
  // Absolute or protocol-relative → ignore
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  const pathOnly = value.split("?")[0]?.split("#")[0] ?? "/";
  const normalized = appPathname(pathOnly);
  if (isPublicPath(normalized)) return "/";
  // Cap length so a broken loop can't explode the URL further
  if (value.length > 512) return "/";
  return value.startsWith("/") ? value : "/";
}
