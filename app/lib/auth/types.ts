export type AuthMode = "kubeconfig" | "impersonate";

export type GithubTeam = {
  org: string;
  slug: string;
};

export type SessionUser = {
  githubLogin: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  /** Allowed orgs this user belongs to (subset of KMC_GITHUB_ORGS). */
  orgs: string[];
  teams: GithubTeam[];
};

export type Actor = {
  user: string;
  groups: string[];
};
