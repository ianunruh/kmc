import { Button, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import {
  IconBrandVscode,
  IconCode,
  IconDeviceDesktop,
  IconExternalLink,
  IconTerminal2,
} from "@tabler/icons-react";
import { Link } from "react-router";
import type { Route } from "./+types/vms.$cluster.$namespace.$name.access";
import { CopyableBlock, CopyableValue, DetailField, DetailSection } from "~/ui";
import { KMC_ANN_WORKSPACE_PATH, KMC_RESOURCE_DEVBOX } from "~/lib/k8s/constants";
import { canOpenConsole, vmConsolePath, vmTerminalPath } from "~/lib/format";
import { getConsoleSshUser } from "~/vms/console-ssh-key.server";
import { loadDevBoxAccess } from "~/devboxes/access.server";
import { useVmDetail } from "~/vms/vm-detail-shared";
import { tracedLoader } from "~/lib/request-traces.server";
import { DEVBOX_TEMPLATES, type DevBoxTemplateId } from "~/devboxes/options";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Access ${params.name ?? "VM"} · kmc` }];
}

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const access = await loadDevBoxAccess(cluster, namespace, name);
  return {
    access,
    sshUser: getConsoleSshUser(),
  };
});

/** Remote-SSH URI with user@host so no SSH config Host entry is required. */
function sshRemoteOpenUri(
  app: "vscode" | "cursor",
  user: string,
  host: string,
  folder: string,
): string {
  const path = folder.startsWith("/") ? folder : `/${folder}`;
  return `${app}://vscode-remote/ssh-remote+${user}@${host}${path}`;
}

export default function VmAccessTab({ loaderData }: Route.ComponentProps) {
  const { vm } = useVmDetail();
  const { access, sshUser } = loaderData;
  const isDevBox = vm.resource === KMC_RESOURCE_DEVBOX;
  const template = vm.template as DevBoxTemplateId | undefined;
  const codeServer = template ? DEVBOX_TEMPLATES[template]?.codeServer === true : false;
  const workspace =
    vm.annotations?.[KMC_ANN_WORKSPACE_PATH]?.trim() || `/home/${sshUser}`;
  const hostAlias = `kmc-${vm.name}`;
  const accessIp = access.accessIpv4;
  const consoleReady = canOpenConsole(vm);

  const sshConfig = accessIp
    ? [
        `Host ${hostAlias}`,
        `  HostName ${accessIp}`,
        `  User ${sshUser}`,
        "  StrictHostKeyChecking accept-new",
      ].join("\n")
    : "";

  const vscodeUri = accessIp
    ? sshRemoteOpenUri("vscode", sshUser, accessIp, workspace)
    : "";
  const cursorUri = accessIp
    ? sshRemoteOpenUri("cursor", sshUser, accessIp, workspace)
    : "";

  const ideHost = codeServer ? access.ideHost : undefined;
  const ideUrl = ideHost && access.envoyConfigured ? `https://${ideHost}` : undefined;

  return (
    <Stack gap="md">
      {codeServer ? (
        <DetailSection title="Browser IDE">
          {ideUrl ? (
            <Stack gap="sm">
              <Text size="sm" c="dimmed">
                Opens in the browser. You’ll sign in with your KCloud account.
              </Text>
              <Group gap="sm">
                <Button
                  component="a"
                  href={ideUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="filled"
                  leftSection={<IconExternalLink size={16} />}
                >
                  Open in browser
                </Button>
              </Group>
              <DetailField label="URL" value={<CopyableValue value={ideUrl} />} />
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">
              Browser IDE isn’t published on this cluster.
            </Text>
          )}
        </DetailSection>
      ) : null}

      {isDevBox || accessIp ? (
        <DetailSection title="Tailscale">
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Connect to KCloud Tailscale, then open the workspace in your editor.
            </Text>
            {accessIp ? (
              <>
                <Text size="xs" c="dimmed">
                  Opens {workspace}
                </Text>
                <Group gap="sm">
                  <Button
                    component="a"
                    href={vscodeUri}
                    variant="filled"
                    leftSection={<IconBrandVscode size={16} />}
                  >
                    Open in VS Code
                  </Button>
                  <Button
                    component="a"
                    href={cursorUri}
                    variant="filled"
                    leftSection={<IconCode size={16} />}
                  >
                    Open in Cursor
                  </Button>
                </Group>
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                  <DetailField
                    label="SSH"
                    value={<CopyableValue value={`ssh ${sshUser}@${accessIp}`} />}
                  />
                  <DetailField
                    label="Address"
                    value={<CopyableValue value={accessIp} />}
                  />
                </SimpleGrid>
              </>
            ) : (
              <Text size="sm" c="dimmed">
                SSH address isn’t ready yet.
              </Text>
            )}
          </Stack>
        </DetailSection>
      ) : null}

      {accessIp ? (
        <DetailSection title="SSH config">
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Optional. Add this if you want a named host in your SSH config.
            </Text>
            <CopyableBlock value={sshConfig} />
          </Stack>
        </DetailSection>
      ) : null}

      <DetailSection title="Console">
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            SSH and serial in this browser.
          </Text>
          <Group gap="sm">
            <Button
              component={Link}
              to={vmTerminalPath(vm)}
              variant="filled"
              leftSection={<IconTerminal2 size={16} />}
              disabled={!consoleReady}
            >
              SSH terminal
            </Button>
            <Button
              component={Link}
              to={vmConsolePath(vm)}
              variant="filled"
              leftSection={<IconDeviceDesktop size={16} />}
              disabled={!consoleReady}
            >
              Serial console
            </Button>
          </Group>
        </Stack>
      </DetailSection>
    </Stack>
  );
}
