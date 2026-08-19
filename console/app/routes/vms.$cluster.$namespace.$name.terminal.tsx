import { Alert, Anchor, Badge, Button, Group, Stack, Text, Title } from "@mantine/core";
import { IconArrowLeft, IconPlugConnected, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/vms.$cluster.$namespace.$name.terminal";
import { canOpenConsole, vmConsolePath, vmPath } from "~/lib/format";
import { StatusBadge } from "~/ui/status-badge";
import { getVm } from "~/vms/vms.server";
import { tracedLoader } from "~/lib/request-traces.server";

/** Client-only terminal props (mirrored to avoid SSR import of xterm). */
type SshConsoleStatus = "connecting" | "open" | "closed" | "error";

type SshConsoleProps = {
  cluster: string;
  namespace: string;
  name: string;
  onStatus?: (status: SshConsoleStatus, detail?: string) => void;
};

type SshConsoleModule = {
  SshConsole: ComponentType<SshConsoleProps>;
  reconnectSshConsole: (root: HTMLElement | null) => void;
};

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Terminal · ${params.name ?? "VM"} · kmc` }];
}

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const vm = await getVm(cluster, namespace, name);
  return { vm };
});

function statusColor(status: SshConsoleStatus): string {
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

export default function VmSshTerminalPage({ loaderData }: Route.ComponentProps) {
  const { vm } = loaderData;
  const [wsStatus, setWsStatus] = useState<SshConsoleStatus>("connecting");
  const [wsDetail, setWsDetail] = useState<string | undefined>();
  const [clientMod, setClientMod] = useState<SshConsoleModule | null>(null);
  const termRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void import("~/vms/ssh-console.client").then((mod) => {
      if (!cancelled) setClientMod(mod);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onStatus = useCallback((status: SshConsoleStatus, detail?: string) => {
    setWsStatus(status);
    setWsDetail(detail);
  }, []);

  const live = canOpenConsole(vm);
  const SshConsole = clientMod?.SshConsole;

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
          <Anchor component={Link} to={vmPath(vm)} size="sm" c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              {vm.name}
            </Group>
          </Anchor>
          <Group gap="sm" mt={6} align="center">
            <Title order={2} size="h3">
              Terminal
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
            {vm.cluster} / {vm.namespace} · SSH via port-forward (platform console key) ·
            close tab to disconnect
          </Text>
        </div>
        <Group>
          <Button
            variant="default"
            leftSection={<IconRefresh size={16} />}
            onClick={() => clientMod?.reconnectSshConsole(termRootRef.current)}
            disabled={!clientMod}
          >
            Reconnect
          </Button>
          <Button component={Link} to={vmConsolePath(vm)} variant="default">
            Serial
          </Button>
          <Button component={Link} to={vmPath(vm)} variant="light">
            Back to VM
          </Button>
        </Group>
      </Group>

      {!live && (
        <Alert color="yellow" variant="light" title="VM may not accept SSH">
          Status is <strong>{vm.status}</strong>. Terminal requires a live VMI with
          sshd and the platform console key in the guest{" "}
          <code>authorized_keys</code> (injected at create for VMs launched from kmc).
        </Alert>
      )}

      <div
        ref={termRootRef}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {SshConsole ? (
          <SshConsole
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
