import { Alert, Anchor, Code, SimpleGrid, Stack, Text } from "@mantine/core";
import type { Route } from "./+types/vms.$cluster.$namespace.$name.access";
import {
  CopyableBlock,
  CopyableValue,
  DetailField,
  DetailSection,
  ResourceLink,
} from "~/ui";
import {
  KMC_ANN_REPO,
  KMC_ANN_WORKSPACE_PATH,
  KMC_RESOURCE_DEVBOX,
} from "~/lib/k8s/constants";
import { vmConsolePath, vmTerminalPath } from "~/lib/format";
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

export default function VmAccessTab({ loaderData }: Route.ComponentProps) {
  const { vm } = useVmDetail();
  const { access, sshUser } = loaderData;
  const isDevBox = vm.resource === KMC_RESOURCE_DEVBOX;
  const template = vm.template as DevBoxTemplateId | undefined;
  const codeServer = template ? DEVBOX_TEMPLATES[template]?.codeServer === true : false;
  const workspace =
    vm.annotations?.[KMC_ANN_WORKSPACE_PATH]?.trim() || `/home/${sshUser}`;
  const repo = vm.annotations?.[KMC_ANN_REPO]?.trim();
  const hostAlias = `kmc-${vm.name}`;
  const accessIp = access.accessIpv4;

  const sshConfig = accessIp
    ? [
        `Host ${hostAlias}`,
        `  HostName ${accessIp}`,
        `  User ${sshUser}`,
        "  StrictHostKeyChecking accept-new",
      ].join("\n")
    : "";

  const vscodeUri = `vscode://vscode-remote/ssh-remote+${hostAlias}${workspace}`;
  const cursorUri = `cursor://vscode-remote/ssh-remote+${hostAlias}${workspace}`;
  const codeCli = `code --folder-uri vscode-remote://ssh-remote+${hostAlias}${workspace}`;
  const cursorCli = `cursor --folder-uri vscode-remote://ssh-remote+${hostAlias}${workspace}`;
  const virtctl = `virtctl ssh ${sshUser}@${vm.name}.${vm.namespace} --namespace ${vm.namespace} --context ${vm.cluster}`;

  const ideHost = codeServer ? access.ideHost : undefined;

  return (
    <Stack gap="md">
      {isDevBox ? (
        <Alert color="gray" variant="light" title="KCloud Tailscale">
          The access IP is a MetalLB VIP on the cluster’s internal pool. SSH and editor
          remotes only work when you are on KCloud Tailscale.
        </Alert>
      ) : null}
      {access.warning ? (
        <Alert color="yellow" variant="light">
          {access.warning}
        </Alert>
      ) : null}

      <DetailSection title="Browser">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <DetailField
            label="SSH terminal"
            value={<ResourceLink to={vmTerminalPath(vm)}>Open terminal</ResourceLink>}
          />
          <DetailField
            label="Serial console"
            value={<ResourceLink to={vmConsolePath(vm)}>Open serial</ResourceLink>}
          />
        </SimpleGrid>
        <Text size="xs" c="dimmed">
          Browser Terminal uses KubeVirt port-forward and the platform key. It does not
          need Tailscale.
        </Text>
      </DetailSection>

      <DetailSection title="Access IP">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <DetailField
            label="SSH address"
            value={
              accessIp ? (
                <CopyableValue value={accessIp} />
              ) : isDevBox ? (
                <Text size="sm" c="dimmed">
                  allocating…
                </Text>
              ) : (
                <Text size="sm" c="dimmed">
                  No Dev Box SSH LoadBalancer
                </Text>
              )
            }
          />
          <DetailField label="User" value={<CopyableValue value={sshUser} />} />
        </SimpleGrid>
      </DetailSection>

      {accessIp ? (
        <DetailSection title="SSH">
          <Stack gap="sm">
            <DetailField
              label="Command"
              value={<CopyableValue value={`ssh ${sshUser}@${accessIp}`} />}
            />
            <div>
              <Text size="xs" c="dimmed" mb={6}>
                SSH config
              </Text>
              <CopyableBlock value={sshConfig} />
            </div>
          </Stack>
        </DetailSection>
      ) : null}

      {accessIp ? (
        <DetailSection title="Editors">
          <Stack gap="sm">
            {repo ? (
              <Text size="xs" c="dimmed">
                Workspace {workspace} (from {repo})
              </Text>
            ) : null}
            <DetailField
              label="VS Code"
              value={
                <Anchor href={vscodeUri} size="sm">
                  Open in VS Code
                </Anchor>
              }
            />
            <CopyableBlock value={codeCli} />
            <DetailField
              label="Cursor"
              value={
                <Anchor href={cursorUri} size="sm">
                  Open in Cursor
                </Anchor>
              }
            />
            <CopyableBlock value={cursorCli} />
            <Text size="xs" c="dimmed">
              Add the SSH config Host above first. Remote-SSH uses{" "}
              <Code>{hostAlias}</Code>.
            </Text>
          </Stack>
        </DetailSection>
      ) : null}

      {codeServer ? (
        <DetailSection title="IDE (code-server)">
          {ideHost && access.envoyConfigured ? (
            <Stack gap="xs">
              <DetailField
                label="URL"
                value={
                  <Anchor href={`https://${ideHost}`} target="_blank" size="sm">
                    https://{ideHost}
                  </Anchor>
                }
              />
              <Text size="xs" c="dimmed">
                Envoy OIDC (same SecurityPolicy shape as other KCloud sites). Not the raw
                access IP on port 8080.
              </Text>
            </Stack>
          ) : (
            <Alert color="yellow" variant="light">
              code-server is installed in the guest, but <Code>devbox.envoy</Code> is not
              configured on this cluster — no IDE URL was published.
            </Alert>
          )}
        </DetailSection>
      ) : null}

      {!isDevBox || !accessIp ? (
        <DetailSection title="virtctl (kubeconfig)">
          <Text size="xs" c="dimmed" mb={6}>
            For VMs without an access VIP, or if you have cluster kubeconfig.
          </Text>
          <CopyableBlock value={virtctl} />
        </DetailSection>
      ) : null}
    </Stack>
  );
}
