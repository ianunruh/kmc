import { redirect } from "react-router";
import type { Route } from "./+types/auth.logout";
import { clearSessionCookie } from "~/lib/auth/session.server";

export async function action({ request }: Route.ActionArgs) {
  throw redirect("/login", {
    headers: { "Set-Cookie": clearSessionCookie(request) },
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  throw redirect("/login", {
    headers: { "Set-Cookie": clearSessionCookie(request) },
  });
}
