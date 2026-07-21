import { parseCookie, stringifySetCookie } from "cookie";
import { redirect } from "react-router";
import type { Route } from "./+types/auth.callback";
import { loadSessionUserFromCode } from "~/lib/auth/github.server";
import { safeReturnTo } from "~/lib/auth/paths.server";
import {
  clearOAuthStateCookie,
  createSessionCookie,
  verifyOAuthState,
} from "~/lib/auth/session.server";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const clearState = clearOAuthStateCookie();
  const clearReturn = stringifySetCookie({
    name: "kmc_oauth_return",
    value: "",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: 0,
  });

  const cookies = parseCookie(request.headers.get("cookie") ?? "");
  const returnTo = safeReturnTo(cookies.kmc_oauth_return);

  if (oauthError) {
    throw redirect(
      `/login?error=${encodeURIComponent(oauthError)}&returnTo=${encodeURIComponent(returnTo)}`,
      {
        headers: [
          ["Set-Cookie", clearState],
          ["Set-Cookie", clearReturn],
        ],
      },
    );
  }

  if (!code || !verifyOAuthState(request, state)) {
    throw redirect(
      `/login?error=${encodeURIComponent("Invalid OAuth state")}&returnTo=${encodeURIComponent(returnTo)}`,
      {
        headers: [
          ["Set-Cookie", clearState],
          ["Set-Cookie", clearReturn],
        ],
      },
    );
  }

  try {
    const user = await loadSessionUserFromCode(code);
    const sessionCookie = await createSessionCookie(user);
    throw redirect(returnTo, {
      headers: [
        ["Set-Cookie", sessionCookie],
        ["Set-Cookie", clearState],
        ["Set-Cookie", clearReturn],
      ],
    });
  } catch (err) {
    if (err instanceof Response) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw redirect(
      `/login?error=${encodeURIComponent(message)}&returnTo=${encodeURIComponent(returnTo)}`,
      {
        headers: [
          ["Set-Cookie", clearState],
          ["Set-Cookie", clearReturn],
        ],
      },
    );
  }
}
