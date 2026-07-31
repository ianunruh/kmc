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
 * Safe post-login redirect target. Rejects open redirects and auth pages.
 * Strips React Router `.data` suffixes so revalidation/XHR paths like
 * `/me.data` become `/me` (otherwise login returnTo loops on data routes).
 * API resource paths are not useful post-login destinations → `/`.
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

  const q = value.indexOf("?");
  const h = value.indexOf("#");
  let pathEnd = value.length;
  if (q >= 0) pathEnd = Math.min(pathEnd, q);
  if (h >= 0) pathEnd = Math.min(pathEnd, h);

  const pathOnly = value.slice(0, pathEnd) || "/";
  const suffix = value.slice(pathEnd);
  const normalized = appPathname(pathOnly);

  if (isPublicPath(normalized)) return "/";
  if (normalized === "/api" || normalized.startsWith("/api/")) return "/";

  const result = `${normalized}${suffix}`;
  if (result.length > 512) return "/";
  return result.startsWith("/") ? result : "/";
}
