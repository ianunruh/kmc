import { Alert, Anchor, Badge, Button, Group, Stack, Text, Title } from "@mantine/core";
import { IconArrowLeft, IconPlugConnected, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/databases.$cluster.$namespace.$name.terminal";
import {
  canOpenDatabaseTerminal,
  databasePath,
} from "~/lib/format";
import { StatusBadge } from "~/ui/status-badge";
import { getDatabase } from "~/databases/databases.server";
import { tracedLoader } from "~/lib/request-traces.server";

/** Client-only terminal props (mirrored to avoid SSR import of xterm). */
type PsqlConsoleStatus = "connecting" | "open" | "closed" | "error";

type PsqlConsoleProps = {
  cluster: string;
  namespace: string;
  name: string;
  onStatus?: (status: PsqlConsoleStatus, detail?: string) => void;
};

type PsqlConsoleModule = {
  PsqlConsole: ComponentType<PsqlConsoleProps>;
  reconnectPsqlConsole: (root: HTMLElement | null) => void;
};

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `psql · ${params.name ?? "Database"} · kmc` }];
}

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const db = await getDatabase(cluster, namespace, name);
  return { db };
});

function statusColor(status: PsqlConsoleStatus): string {
  switch (status) {
    case "open":
      return "teal";
    case "connecting":
      return "yellow";
    case "error":
      return "red";
    case "closed":
    default:
      return "gray";
  }
}

export default function DatabasePsqlTerminalPage({
  loaderData,
}: Route.ComponentProps) {
  const { db } = loaderData;
  const [wsStatus, setWsStatus] = useState<PsqlConsoleStatus>("connecting");
  const [wsDetail, setWsDetail] = useState<string | undefined>();
  const [clientMod, setClientMod] = useState<PsqlConsoleModule | null>(null);
  const termRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void import("~/databases/psql-console.client").then((mod) => {
      if (!cancelled) setClientMod(mod);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onStatus = useCallback((status: PsqlConsoleStatus, detail?: string) => {
    setWsStatus(status);
    setWsDetail(detail);
  }, []);

  const live = canOpenDatabaseTerminal(db);
  const PsqlConsole = clientMod?.PsqlConsole;
  const appUser =
    db.appCredentials?.username ?? db.owner ?? "app";
  const appDb =
    db.appCredentials?.database ?? db.databaseName ?? "app";

  return (
    <Stack
      gap="sm"
      style={{
        minHeight: "calc(100vh - 52px - 48px)",
        height: "calc(100vh - 52px - 48px)",
      }}
    >
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Anchor component={Link} to={databasePath(db)} size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              {db.name}
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              psql
            </Title>
            <StatusBadge status={db.status} />
            <Badge
              size="sm"
              variant="outline"
              color={statusColor(wsStatus)}
              leftSection={<IconPlugConnected size={12} />}
            >
              {wsStatus}
              {wsDetail ? ` · ${wsDetail}` : ""}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed" mt={4}>
            {db.cluster} / {db.namespace} · app user{" "}
            <code>
              {appUser}@{appDb}
            </code>{" "}
            via primary pod exec · close tab to disconnect
          </Text>
        </div>
        <Group>
          <Button
            variant="default"
            leftSection={<IconRefresh size={16} />}
            onClick={() => clientMod?.reconnectPsqlConsole(termRootRef.current)}
            disabled={!clientMod}
          >
            Reconnect
          </Button>
          <Button component={Link} to={databasePath(db)} variant="light">
            Back to database
          </Button>
        </Group>
      </Group>

      {!live && (
        <Alert color="yellow" variant="light" title="Database may not accept connections">
          Status is <strong>{db.status}</strong>
          {db.readyInstances != null
            ? ` (${db.readyInstances}/${db.instances} ready)`
            : ""}
          . Terminal requires a primary instance and the app connection secret.
        </Alert>
      )}

      <div
        ref={termRootRef}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {PsqlConsole ? (
          <PsqlConsole
            cluster={db.cluster}
            namespace={db.namespace}
            name={db.name}
            onStatus={onStatus}
          />
        ) : (
          <Text size="sm" c="dimmed" p="md">
            Loading terminal…
          </Text>
        )}
      </div>
    </Stack>
  );
}
