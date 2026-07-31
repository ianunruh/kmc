import { AsyncLocalStorage } from "node:async_hooks";
import type { Actor, SessionUser } from "./types";

export type { Actor };

const storage = new AsyncLocalStorage<Actor | null>();

export function runWithActor<T>(actor: Actor | null, fn: () => T): T {
  return storage.run(actor, fn);
}

export function getActor(): Actor | null {
  return storage.getStore() ?? null;
}

export function requireActor(): Actor {
  const actor = getActor();
  if (!actor) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return actor;
}

export function usernamePrefix(): string {
  return process.env.KMC_USERNAME_PREFIX ?? "oidc:";
}

export function groupsPrefix(): string {
  return process.env.KMC_GROUPS_PREFIX ?? "oidc:";
}

/**
 * Map a GitHub session identity to the Kubernetes principal shape used by
 * the apiserver OIDC config: user `oidc:<email>`, groups `oidc:<org>:<team>`.
 */
export function toActor(user: SessionUser): Actor {
  const uPrefix = usernamePrefix();
  const gPrefix = groupsPrefix();
  const groups = new Set<string>(["system:authenticated"]);
  for (const team of user.teams) {
    groups.add(`${gPrefix}${team.org}:${team.slug}`);
  }
  return {
    user: `${uPrefix}${user.email}`,
    groups: [...groups],
  };
}
