import { AsyncLocalStorage } from "node:async_hooks";
import { redirect } from "react-router";
import { runWithActor, toActor } from "./actor.server";
import { isImpersonateMode } from "./mode.server";
import { isPublicPath, safeReturnTo } from "./paths.server";
import { getSession, type SessionData } from "./session.server";

const currentSessionStorage = new AsyncLocalStorage<SessionData | null>();

/** Session for the current request (set by authMiddleware). */
export function getRequestSession(): SessionData | null {
  return currentSessionStorage.getStore() ?? null;
}

/**
 * Root middleware: session → Actor ALS for impersonation; gate protected routes.
 * Loaders/actions stay flat — getClusterClients() reads the actor from ALS.
 */
export async function authMiddleware(
  { request }: { request: Request },
  next: () => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const publicRoute = isPublicPath(url.pathname);

  let session: SessionData | null = null;
  try {
    session = await getSession(request);
  } catch {
    session = null;
  }

  if (isImpersonateMode() && !publicRoute && !session?.user) {
    const returnTo = safeReturnTo(`${url.pathname}${url.search}`);
    throw redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  const actorForK8s = isImpersonateMode() && session?.user ? toActor(session.user) : null;

  return runWithActor(actorForK8s, () =>
    currentSessionStorage.run(session, () => next()),
  );
}
