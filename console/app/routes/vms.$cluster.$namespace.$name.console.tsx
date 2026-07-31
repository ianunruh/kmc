import { Alert, Anchor, Badge, Button, Group, Stack, Text, Title } from "@mantine/core";
import { IconArrowLeft, IconPlugConnected, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/vms.$cluster.$namespace.$name.console";
import { canOpenConsole, vmPath, vmTerminalPath } from "~/lib/format";
import { StatusBadge } from "~/ui/status-badge";
import { getVm } from "~/vms/vms.server";

/** Client-only terminal props (mirrored to avoid SSR import of xterm). */
type SerialConsoleStatus = "connecting" | "open" | "closed" | "error";

type SerialConsoleProps = {
  cluster: string;
  namespace: string;
  name: string;
  onStatus?: (status: SerialConsoleStatus, detail?: string) => void;
};

type SerialConsoleModule = {
  SerialConsole: ComponentType<SerialConsoleProps>;
  reconnectSerialConsole: (root: HTMLElement | null) => void;
};

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Console · ${params.name ?? "VM"} · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const vm = await getVm(cluster, namespace, name);
  return { vm };
}

function statusColor(status: SerialConsoleStatus): string {
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

export default function VmSerialConsolePage({ loaderData }: Route.ComponentProps) {
  const { vm } = loaderData;
  const [wsStatus, setWsStatus] = useState<SerialConsoleStatus>("connecting");
  const [wsDetail, setWsDetail] = useState<string | undefined>();
  const [clientMod, setClientMod] = useState<SerialConsoleModule | null>(null);
  const termRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void import("~/vms/serial-console.client").then((mod) => {
      if (!cancelled) setClientMod(mod);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onStatus = useCallback((status: SerialConsoleStatus, detail?: string) => {
    setWsStatus(status);
    setWsDetail(detail);
  }, []);

  const live = canOpenConsole(vm);
  const SerialConsole = clientMod?.SerialConsole;

  return (
    <Stack
      gap="sm"
      style={{
        // Fill chrome main area
        minHeight: "calc(100vh - 52px - 48px)",
        height: "calc(100vh - 52px - 48px)",
      }}
    >
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Anchor component={Link} to={vmPath(vm)} size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              {vm.name}
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              Serial console
            </Title>
            <StatusBadge status={vm.status} />
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
            {vm.cluster} / {vm.namespace} · age {vm.age} · close tab or navigate away to
            disconnect
          </Text>
        </div>
        <Group>
          <Button
            variant="default"
            leftSection={<IconRefresh size={16} />}
            onClick={() => clientMod?.reconnectSerialConsole(termRootRef.current)}
            disabled={!clientMod}
          >
            Reconnect
          </Button>
          <Button component={Link} to={vmTerminalPath(vm)} variant="default">
            Terminal
          </Button>
          <Button component={Link} to={vmPath(vm)} variant="light">
            Back to VM
          </Button>
        </Group>
      </Group>

      {!live && (
        <Alert color="yellow" variant="light" title="VM may not accept console">
          Status is <strong>{vm.status}</strong>. Serial console usually requires a live
          VMI (Running). Start the VM, then reconnect.
        </Alert>
      )}

      <div
        ref={termRootRef}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {SerialConsole ? (
          <SerialConsole
            cluster={vm.cluster}
            namespace={vm.namespace}
            name={vm.name}
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
