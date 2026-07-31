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

/**
 * Orgs that may sign in and whose teams map to k8s groups.
 * Empty = no app-level org filter (any GitHub user can log in).
 */
export function allowedGithubOrgs(): string[] {
  const raw = process.env.KMC_GITHUB_ORGS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True when the session user is a member of at least one KMC_GITHUB_ORGS entry.
 * When KMC_GITHUB_ORGS is unset, always true.
 *
 * Accepts legacy sessions that only stored teams (infers orgs from team.org).
 */
export function sessionUserPassesOrgFilter(user: SessionUser): boolean {
  const allowed = allowedGithubOrgs();
  if (allowed.length === 0) return true;

  const memberOrgs = new Set<string>();
  for (const org of user.orgs ?? []) {
    if (org) memberOrgs.add(org.toLowerCase());
  }
  for (const team of user.teams ?? []) {
    if (team.org) memberOrgs.add(team.org.toLowerCase());
  }
  return allowed.some((org) => memberOrgs.has(org));
}

export function orgAccessDeniedMessage(): string {
  const allowed = allowedGithubOrgs();
  const list = allowed.length > 0 ? allowed.join(", ") : "the required organization";
  return (
    `Access denied: you must be a member of ${list}. ` +
    "If you are, ask an org admin to approve this OAuth app for the organization."
  );
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

export async function loadSessionUserFromCode(code: string): Promise<SessionUser> {
  const token = await exchangeCode(code);
  const allowed = allowedGithubOrgs();
  const allowedSet = new Set(allowed);

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

  let orgs: string[] = [];
  try {
    // With read:org, returns orgs the user belongs to (incl. private membership
    // once the OAuth app is approved for that org).
    const rawOrgs = await ghJson<Array<{ login?: string }>>(
      token,
      "/user/orgs?per_page=100",
    );
    orgs = rawOrgs
      .map((o) => o.login ?? "")
      .filter(Boolean)
      .filter((login) => allowedSet.size === 0 || allowedSet.has(login.toLowerCase()));
  } catch (err) {
    console.warn(
      "[kmc:auth] failed to list GitHub orgs — org filter may deny login",
      err instanceof Error ? err.message : err,
    );
  }

  let teams: GithubTeam[] = [];
  try {
    const rawTeams = await ghJson<
      Array<{ slug: string; organization?: { login?: string } }>
    >(token, "/user/teams?per_page=100");
    teams = rawTeams
      .map((t) => ({
        org: t.organization?.login ?? "",
        slug: t.slug,
      }))
      .filter((t) => t.org && t.slug)
      .filter((t) => allowedSet.size === 0 || allowedSet.has(t.org.toLowerCase()));
  } catch (err) {
    // read:org may be denied until the OAuth app is approved for the org.
    console.warn(
      "[kmc:auth] failed to list GitHub teams — user will have no org groups",
      err instanceof Error ? err.message : err,
    );
  }

  // If org listing failed but teams from an allowed org succeeded, count those orgs.
  if (orgs.length === 0 && teams.length > 0) {
    orgs = [...new Set(teams.map((t) => t.org))];
  }

  const user: SessionUser = {
    githubLogin: profile.login,
    email,
    name: profile.name ?? undefined,
    avatarUrl: profile.avatar_url,
    orgs,
    teams,
  };

  if (!sessionUserPassesOrgFilter(user)) {
    console.warn(
      `[kmc:auth] denied login for ${profile.login} — not in allowed orgs ` +
        `(${allowed.join(",") || "none configured"})`,
    );
    throw new Error(orgAccessDeniedMessage());
  }

  return user;
}
