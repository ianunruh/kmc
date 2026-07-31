import { Alert, Code, SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import {
  CopyableValue,
  DetailField,
  DetailSection,
  RevealableValue,
} from "~/ui";
import type { DatabaseRoleCredentials } from "~/lib/types";
import type { loader as detailLoader } from "./databases.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/databases.$cluster.$namespace.$name";

function serviceFqdn(service: string, namespace: string): string {
  return `${service}.${namespace}.svc`;
}

function CredentialsPanel({
  title,
  creds,
  fallbackHost,
  fallbackDatabase,
}: {
  title: string;
  creds?: DatabaseRoleCredentials;
  fallbackHost?: string;
  fallbackDatabase?: string;
}) {
  if (!creds) return null;

  if (creds.error && !creds.password && !creds.username) {
    return (
      <DetailSection title={title}>
        <Alert color="yellow" variant="light" title="Credentials unavailable">
          {creds.error}
        </Alert>
        <Text size="xs" c="dimmed" mt="xs">
          Secret: <Code>{creds.secretName}</Code>
        </Text>
      </DetailSection>
    );
  }

  const hostDisplay =
    creds.hostFqdn || creds.host || fallbackHost || undefined;
  const database = creds.database || fallbackDatabase;
  const uri = creds.fqdnUri || creds.uri;

  return (
    <DetailSection title={title}>
      <SimpleGrid cols={1} spacing="sm">
        {creds.error ? (
          <Alert color="yellow" variant="light">
            {creds.error}
          </Alert>
        ) : null}
        <DetailField
          label="Host"
          value={hostDisplay ? <CopyableValue value={hostDisplay} /> : undefined}
        />
        <DetailField
          label="Port"
          value={
            creds.port ? <CopyableValue value={creds.port} /> : undefined
          }
        />
        <DetailField
          label="Database"
          value={database ? <CopyableValue value={database} /> : undefined}
        />
        <DetailField
          label="Username"
          value={
            creds.username ? (
              <CopyableValue value={creds.username} />
            ) : undefined
          }
        />
        <DetailField
          label="Password"
          value={
            creds.password ? (
              <RevealableValue value={creds.password} />
            ) : undefined
          }
        />
        <DetailField
          label="Connection URI"
          value={uri ? <RevealableValue value={uri} /> : undefined}
        />
        <Text size="xs" c="dimmed">
          From Secret <Code>{creds.secretName}</Code>
          {creds.role === "superuser"
            ? " · postgres superuser (enableSuperuserAccess)"
            : " · application role"}
        </Text>
      </SimpleGrid>
    </DetailSection>
  );
}

export default function DatabaseAccessTab() {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { db } = data;

  const writeFqdn = db.writeService
    ? serviceFqdn(db.writeService, db.namespace)
    : undefined;

  return (
    <Stack gap="md">
      <DetailSection title="Services">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <DetailField
            label="Write service (RW)"
            value={
              db.writeService ? (
                <CopyableValue
                  value={serviceFqdn(db.writeService, db.namespace)}
                />
              ) : undefined
            }
          />
          <DetailField
            label="Read service"
            value={
              db.readService ? (
                <CopyableValue
                  value={serviceFqdn(db.readService, db.namespace)}
                />
              ) : undefined
            }
          />
          <DetailField
            label="Read-only service"
            value={
              db.readOnlyService ? (
                <CopyableValue
                  value={serviceFqdn(db.readOnlyService, db.namespace)}
                />
              ) : (
                <Text size="sm" c="dimmed">
                  — (single instance)
                </Text>
              )
            }
          />
          <DetailField label="Port" value="5432" />
        </SimpleGrid>
        <Text size="xs" c="dimmed" mt="sm">
          In-cluster apps use these ClusterIP services. Prefer the write service
          for primary traffic; use read / read-only for replicas.
        </Text>
      </DetailSection>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <CredentialsPanel
          title="Application credentials"
          creds={db.appCredentials}
          fallbackHost={writeFqdn}
          fallbackDatabase={db.databaseName}
        />
        {db.enableSuperuserAccess || db.superuserCredentials ? (
          <CredentialsPanel
            title="Superuser credentials"
            creds={db.superuserCredentials}
            fallbackHost={writeFqdn}
          />
        ) : (
          <DetailSection title="Superuser credentials">
            <Text size="sm" c="dimmed">
              Superuser access is disabled on this cluster (
              <Code>enableSuperuserAccess: false</Code>). kmc-created databases
              enable it by default.
            </Text>
          </DetailSection>
        )}
      </SimpleGrid>
    </Stack>
  );
}
