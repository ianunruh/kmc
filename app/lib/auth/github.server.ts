import type { GithubTeam, SessionUser } from "./types";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required for GitHub OAuth`);
  return v;
}

export function publicUrl(): string {
  return (process.env.KMC_PUBLIC_URL ?? "http://localhost:5173").replace(/\/$/, "");
}

export function githubCallbackUrl(): string {
  return `${publicUrl()}/auth/callback`;
}

export function githubAuthorizeUrl(state: string): string {
  const clientId = requireEnv("KMC_GITHUB_CLIENT_ID");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: githubCallbackUrl(),
    scope: "read:user user:email read:org",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

async function exchangeCode(code: string): Promise<string> {
  const clientId = requireEnv("KMC_GITHUB_CLIENT_ID");
  const clientSecret = requireEnv("KMC_GITHUB_CLIENT_SECRET");
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: githubCallbackUrl(),
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!body.access_token) {
    throw new Error(
      body.error_description || body.error || "GitHub token exchange failed",
    );
  }
  return body.access_token;
}

async function ghJson<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "kmc-console",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub API ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  }
  return res.json() as Promise<T>;
}

function allowedOrgs(): Set<string> | null {
  const raw = process.env.KMC_GITHUB_ORGS?.trim();
  if (!raw) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function loadSessionUserFromCode(code: string): Promise<SessionUser> {
  const token = await exchangeCode(code);

  const profile = await ghJson<{
    login: string;
    name?: string | null;
    avatar_url?: string;
    email?: string | null;
  }>(token, "/user");

  const emails = await ghJson<
    Array<{ email: string; primary: boolean; verified: boolean }>
  >(token, "/user/emails");

  const primary =
    emails.find((e) => e.primary && e.verified) ??
    emails.find((e) => e.verified) ??
    emails.find((e) => e.primary);

  const email = primary?.email || profile.email;
  if (!email) {
    throw new Error(
      "No verified email on the GitHub account — cannot map to oidc:<email>",
    );
  }

  let teams: GithubTeam[] = [];
  try {
    const rawTeams = await ghJson<
      Array<{ slug: string; organization?: { login?: string } }>
    >(token, "/user/teams?per_page=100");
    const orgs = allowedOrgs();
    teams = rawTeams
      .map((t) => ({
        org: t.organization?.login ?? "",
        slug: t.slug,
      }))
      .filter((t) => t.org && t.slug)
      .filter((t) => !orgs || orgs.has(t.org.toLowerCase()));
  } catch (err) {
    // read:org may be denied until the OAuth app is approved for the org.
    console.warn(
      "[kmc:auth] failed to list GitHub teams — user will have no org groups",
      err instanceof Error ? err.message : err,
    );
  }

  return {
    githubLogin: profile.login,
    email,
    name: profile.name ?? undefined,
    avatarUrl: profile.avatar_url,
    teams,
  };
}
