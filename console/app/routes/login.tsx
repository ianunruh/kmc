import { useState } from "react";
import { Alert, Anchor, Button, Stack, Text, Title } from "@mantine/core";
import { IconBrandGithub } from "@tabler/icons-react";
import { Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/login";
import { isImpersonateMode } from "~/lib/auth/mode.server";
import { safeReturnTo } from "~/lib/auth/paths.server";
import { getSession } from "~/lib/auth/session.server";
import { ConsolePaper } from "~/ui";
import { tracedLoader } from "~/lib/request-traces.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Sign in · kmc" }];
}

export const loader = tracedLoader(async ({ request }: Route.LoaderArgs) => {
  const session = await getSession(request).catch(() => null);
  if (session?.user) {
    throw redirect("/");
  }
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const allowedOrgs = (process.env.KMC_GITHUB_ORGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    error,
    returnTo,
    impersonateMode: isImpersonateMode(),
    allowedOrgs,
  };
});

export default function LoginPage({ loaderData }: Route.ComponentProps) {
  const { error, returnTo, impersonateMode, allowedOrgs } = loaderData;
  const href = `/auth/github?returnTo=${encodeURIComponent(returnTo)}`;
  const navigation = useNavigation();
  const [clicked, setClicked] = useState(false);

  // Cover click → /auth/github hop and in-app transitions
  const signingIn = clicked || navigation.state !== "idle";

  return (
    <Stack maw={420} mx="auto" mt={80} gap="lg">
      <div>
        <Title order={2} tt="lowercase" c="accent.4">
          kmc
        </Title>
        <Text size="sm" c="dimmed" mt={4}>
          kcloud management console
        </Text>
      </div>

      <ConsolePaper>
        <Stack gap="md">
          <Text size="sm">
            Sign in with GitHub. Your identity maps to Kubernetes principals as{" "}
            <Text span ff="monospace" size="sm">
              oidc:&lt;email&gt;
            </Text>{" "}
            and org teams as{" "}
            <Text span ff="monospace" size="sm">
              oidc:&lt;org&gt;:&lt;team&gt;
            </Text>
            .
            {allowedOrgs.length > 0 && (
              <>
                {" "}
                Access is limited to members of{" "}
                {allowedOrgs.map((org, i) => (
                  <span key={org}>
                    {i > 0 && (i === allowedOrgs.length - 1 ? " or " : ", ")}
                    <Text span ff="monospace" size="sm">
                      {org}
                    </Text>
                  </span>
                ))}
                .
              </>
            )}
          </Text>

          {!impersonateMode && (
            <Alert color="yellow" title="kubeconfig mode">
              Auth mode is still <code>kubeconfig</code>. Login works for identity preview
              on{" "}
              <Anchor component={Link} to="/me">
                /me
              </Anchor>
              , but API calls use your local kubeconfig (no impersonation).
            </Alert>
          )}

          {error && !signingIn && (
            <Alert color="red" title="Sign-in failed">
              {error}
            </Alert>
          )}

          {signingIn && (
            <Alert color="blue" title="Signing in">
              Redirecting to GitHub… complete authorization there, then you&apos;ll return
              here.
            </Alert>
          )}

          <Button
            component="a"
            href={href}
            leftSection={<IconBrandGithub size={18} />}
            fullWidth
            loading={signingIn}
            disabled={signingIn}
            onClick={() => setClicked(true)}
          >
            {signingIn ? "Redirecting to GitHub…" : "Sign in with GitHub"}
          </Button>
        </Stack>
      </ConsolePaper>
    </Stack>
  );
}
