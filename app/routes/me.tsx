import { Badge, Code, Stack, Table, Text, Title } from "@mantine/core";
import type { Route } from "./+types/me";
import { toActor } from "~/lib/auth/actor.server";
import { getRequestSession } from "~/lib/auth/middleware.server";
import { getAuthMode } from "~/lib/auth/mode.server";
import { ConsolePaper, PageHeader } from "~/ui";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Identity · kmc" }];
}

export async function loader(_args: Route.LoaderArgs) {
  const mode = getAuthMode();
  const session = getRequestSession();
  const displayActor = session?.user ? toActor(session.user) : null;
  return {
    mode,
    session: session
      ? {
          githubLogin: session.user.githubLogin,
          email: session.user.email,
          name: session.user.name,
          teams: session.user.teams,
          exp: session.exp,
        }
      : null,
    actor: displayActor,
  };
}

export default function MePage({ loaderData }: Route.ComponentProps) {
  const { mode, session, actor } = loaderData;

  return (
    <Stack gap="md">
      <PageHeader
        title="Identity"
        description="Console session and the Kubernetes principal used for impersonation"
      />

      <ConsolePaper>
        <Stack gap="sm">
          <Text size="sm">
            Auth mode: <Badge variant="light">{mode}</Badge>
          </Text>

          {!session ? (
            <Text size="sm" c="dimmed">
              Not signed in.{" "}
              {mode === "impersonate"
                ? "Sign in is required to use the console."
                : "Optional in kubeconfig mode."}
            </Text>
          ) : (
            <>
              <Title order={5}>GitHub session</Title>
              <Table withTableBorder withColumnBorders>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td w={140}>Login</Table.Td>
                    <Table.Td>
                      <Code>{session.githubLogin}</Code>
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Email</Table.Td>
                    <Table.Td>
                      <Code>{session.email}</Code>
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Name</Table.Td>
                    <Table.Td>{session.name || "—"}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Teams</Table.Td>
                    <Table.Td>
                      {session.teams.length === 0 ? (
                        <Text size="sm" c="yellow">
                          none (check OAuth App org approval / KMC_GITHUB_ORGS)
                        </Text>
                      ) : (
                        session.teams.map((t) => (
                          <Code key={`${t.org}/${t.slug}`} mr={6}>
                            {t.org}:{t.slug}
                          </Code>
                        ))
                      )}
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Expires</Table.Td>
                    <Table.Td>
                      <Code>{new Date(session.exp * 1000).toISOString()}</Code>
                    </Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>

              <Title order={5} mt="sm">
                Kubernetes actor
              </Title>
              {actor ? (
                <Table withTableBorder withColumnBorders>
                  <Table.Tbody>
                    <Table.Tr>
                      <Table.Td w={140}>Impersonate-User</Table.Td>
                      <Table.Td>
                        <Code>{actor.user}</Code>
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>Impersonate-Group</Table.Td>
                      <Table.Td>
                        {actor.groups.map((g) => (
                          <div key={g}>
                            <Code>{g}</Code>
                          </div>
                        ))}
                      </Table.Td>
                    </Table.Tr>
                  </Table.Tbody>
                </Table>
              ) : (
                <Text size="sm" c="dimmed">
                  No actor
                </Text>
              )}
            </>
          )}
        </Stack>
      </ConsolePaper>
    </Stack>
  );
}
