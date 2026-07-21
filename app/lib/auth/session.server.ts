import { randomBytes, timingSafeEqual } from "node:crypto";
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

/** Opaque session id → data. Process-local; restart clears sessions. */
const sessions = new Map<string, SessionData>();

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

export async function getSession(request: Request): Promise<SessionData | null> {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const id = parseCookie(header)[COOKIE_NAME];
  if (!id) return null;

  const data = sessions.get(id);
  if (!data) return null;
  if (Date.now() / 1000 > data.exp) {
    sessions.delete(id);
    return null;
  }
  return data;
}

export async function createSessionCookie(user: SessionUser): Promise<string> {
  const id = randomBytes(24).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + sessionTtlSeconds();
  sessions.set(id, { user, exp });
  return setCookie(COOKIE_NAME, id, sessionTtlSeconds());
}

export function clearSessionCookie(request?: Request): string {
  if (request) {
    const header = request.headers.get("cookie");
    if (header) {
      const id = parseCookie(header)[COOKIE_NAME];
      if (id) sessions.delete(id);
    }
  }
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
