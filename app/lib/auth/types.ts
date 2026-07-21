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
  teams: GithubTeam[];
};

export type Actor = {
  user: string;
  groups: string[];
};
