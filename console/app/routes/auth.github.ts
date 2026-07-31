import { redirect } from "react-router";
import type { Route } from "./+types/auth.github";
import { createOAuthState } from "~/lib/auth/session.server";
import { githubAuthorizeUrl } from "~/lib/auth/github.server";
import { safeReturnTo } from "~/lib/auth/paths.server";
import { stringifySetCookie } from "cookie";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));

  const { state, setCookie: stateCookie } = createOAuthState();

  // Stash returnTo alongside state in a short-lived cookie
  const returnCookie = stringifySetCookie({
    name: "kmc_oauth_return",
    value: returnTo,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: (process.env.KMC_PUBLIC_URL ?? "").startsWith("https://"),
    maxAge: 600,
  });

  throw redirect(githubAuthorizeUrl(state), {
    headers: [
      ["Set-Cookie", stateCookie],
      ["Set-Cookie", returnCookie],
    ],
  });
}
