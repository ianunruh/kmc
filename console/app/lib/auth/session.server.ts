import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseCookie, stringifySetCookie } from "cookie";
import type { SessionUser } from "./types";

export type { SessionUser, GithubTeam } from "./types";

export type SessionData = {
  user: SessionUser;
  exp: number;
};

const COOKIE_NAME = "kmc_session";
const STATE_COOKIE = "kmc_oauth_state";
const DEFAULT_TTL_SECONDS = 60 * 60 * 12; // 12h

function sessionTtlSeconds(): number {
  const raw = process.env.KMC_SESSION_TTL_SECONDS;
  if (!raw) return DEFAULT_TTL_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_SECONDS;
}

function publicUrlIsHttps(): boolean {
  const url = process.env.KMC_PUBLIC_URL ?? "http://localhost:5173";
  return url.startsWith("https://");
}

/**
 * Session signing key. Prefer KMC_SESSION_SECRET; fall back is only for
 * accidental local misconfig (sessions won't survive restarts either way if
 * secret changes).
 */
function sessionSecret(): string {
  const secret = process.env.KMC_SESSION_SECRET?.trim();
  if (secret && secret.length >= 32) return secret;
  // Weak fallback keeps oauth state cookies working if someone forgets the env
  // in pure kubeconfig mode; impersonate logins should always set a real secret.
  return "kmc-dev-insecure-session-secret-do-not-use";
}

function setCookie(name: string, value: string, maxAge: number): string {
  return stringifySetCookie({
    name,
    value,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: publicUrlIsHttps(),
    maxAge,
  });
}

/** HMAC-signed payload: base64url(json).base64url(sig) — survives process reloads. */
function seal(data: SessionData): string {
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  const sig = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function unseal(token: string): SessionData | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payload || !sig) return null;

  const expected = createHmac("sha256", sessionSecret())
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as SessionData;
    if (!data?.user?.email || typeof data.exp !== "number") return null;
    if (Date.now() / 1000 > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

export async function getSession(request: Request): Promise<SessionData | null> {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const token = parseCookie(header)[COOKIE_NAME];
  if (!token) return null;
  return unseal(token);
}

export async function createSessionCookie(user: SessionUser): Promise<string> {
  const secret = process.env.KMC_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(
      "KMC_SESSION_SECRET must be set (≥32 chars) to create login sessions. " +
        "Generate one with: openssl rand -hex 32",
    );
  }
  const exp = Math.floor(Date.now() / 1000) + sessionTtlSeconds();
  const token = seal({ user, exp });
  return setCookie(COOKIE_NAME, token, sessionTtlSeconds());
}

export function clearSessionCookie(_request?: Request): string {
  return setCookie(COOKIE_NAME, "", 0);
}

export function createOAuthState(): { state: string; setCookie: string } {
  const state = randomBytes(16).toString("hex");
  return { state, setCookie: setCookie(STATE_COOKIE, state, 600) };
}

export function readOAuthState(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  return parseCookie(header)[STATE_COOKIE] ?? null;
}

export function clearOAuthStateCookie(): string {
  return setCookie(STATE_COOKIE, "", 0);
}

export function verifyOAuthState(request: Request, state: string | null): boolean {
  if (!state) return false;
  const expected = readOAuthState(request);
  if (!expected || expected.length !== state.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(state));
  } catch {
    return false;
  }
}
