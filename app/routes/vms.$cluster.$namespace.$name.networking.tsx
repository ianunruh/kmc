import {
  Button,
  Code,
  Group,
  Stack,
  Table,
  Text,
  Anchor,
} from "@mantine/core";
import { IconPlus, IconWorld, IconWorldWww } from "@tabler/icons-react";
import { useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/vms.$cluster.$namespace.$name.networking";
import {
  ConfirmActionModal,
  DetailSection,
  ResourceLink,
} from "~/ui";
import { StatusBadge } from "~/ui/status-badge";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  floatingIpCreatePath,
  floatingIpsListPath,
  formatAge,
  ingressHostUrl,
  ingressPath,
  ingressesListPath,
  vpcPath,
} from "~/lib/format";
import type { FloatingIpSummary, IngressSummary } from "~/lib/types";
import { listIngressesForVm } from "~/ingresses/ingresses.server";
import { disassociateFloatingIp, listFloatingIpsForVm } from "~/vpcs/vpcs.server";
import { getVm } from "~/vms/vms.server";
import { addressFromIpv4Annotation } from "~/lib/ipam/cidr";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { useVmDetail, type VmDetailActionResult } from "~/vms/vm-detail-shared";

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  // Parent layout also loads the VM; re-fetch for FIP matching + VPC prefill.
  const vm = await getVm(cluster, namespace, name);
  const privateAddrs = (vm.allocatedIpv4 ?? "")
    .split(",")
    .map((p) => addressFromIpv4Annotation(p.trim()) ?? p.trim())
    .filter(Boolean);

  let floatingIps: FloatingIpSummary[] = [];
  try {
    floatingIps = await listFloatingIpsForVm(cluster, namespace, name, privateAddrs);
  } catch {
    floatingIps = [];
  }

  let ingresses: IngressSummary[] = [];
  try {
    ingresses = await listIngressesForVm(cluster, namespace, name);
  } catch {
    ingresses = [];
  }

  const vpcPrefill = vm.networks.find((n) => n.vpc)?.vpc;

  return {
    floatingIps,
    ingresses,
    vpcPrefill: vpcPrefill
      ? {
          cluster,
          namespace: vpcPrefill.namespace,
          name: vpcPrefill.name,
        }
      : null,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing path params" };
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "disassociate-fip") {
      const vpcName = String(form.get("vpcName") ?? "").trim();
      const idOrPublic = String(form.get("idOrPublic") ?? "").trim();
      if (!vpcName || !idOrPublic) {
        return { ok: false, error: "Missing floating IP identity", intent };
      }
      await disassociateFloatingIp({
        cluster,
        namespace,
        vpcName,
        idOrPublic,
      });
      return { ok: true, intent };
    }
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  } catch (err) {
    return actionFailure(`vm.${intent}`, err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

export default function VmNetworkingTab({ loaderData }: Route.ComponentProps) {
  const { vm } = useVmDetail();
  const { floatingIps, ingresses, vpcPrefill } = loaderData;
  const fetcher = useFetcher<VmDetailActionResult>();
  const { refreshNow } = useRefresh();
  const [disassociateTarget, setDisassociateTarget] = useState<FloatingIpSummary | null>(
    null,
  );
  const busy = fetcher.state !== "idle";

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error, {
        intent: data.intent,
        cluster: vm.cluster,
        namespace: vm.namespace,
        name: vm.name,
      });
      return;
    }
    if (data.ok && data.intent === "disassociate-fip") {
      notifyActionSuccess(
        "Done",
        "Floating IP disassociated — public address is held (not released)",
      );
      refreshNow();
    }
  });

  return (
    <Stack gap="md">
      <DetailSection title="Networks">
        {vm.networks.length === 0 ? (
          <Text size="sm" c="dimmed">
            No networks configured
          </Text>
        ) : (
          <Table.ScrollContainer
            className="kmc-table-scroll"
            minWidth={560}
            type="native"
          >
            <Table className="kmc-table" verticalSpacing="xs" withRowBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Guest NIC</Table.Th>
                  <Table.Th>Attachment</Table.Th>
                  <Table.Th>Binding</Table.Th>
                  <Table.Th>MAC</Table.Th>
                  <Table.Th>IPs</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {vm.networks.map((net) => (
                  <Table.Tr key={net.name}>
                    <Table.Td>
                      {net.name}
                      {net.linkState ? (
                        <Text size="xs" c="dimmed">
                          {net.linkState}
                        </Text>
                      ) : null}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {net.guestInterfaceName ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {net.multusNetworkName ? (
                        net.vpc ? (
                          <Group gap={4} wrap="nowrap">
                            <Text size="sm" component="span">
                              multus:
                            </Text>
                            <ResourceLink to={vpcPath(net.vpc)}>
                              {net.multusNetworkName}
                            </ResourceLink>
                          </Group>
                        ) : (
                          `multus:${net.multusNetworkName}`
                        )
                      ) : net.pod ? (
                        "pod"
                      ) : (
                        "—"
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {net.binding ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {net.mac ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {net.ipAddresses?.length ? net.ipAddresses.join(", ") : "—"}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </DetailSection>

      <DetailSection
        title="Floating IPs"
        actions={
          <Group gap="xs">
            <Button
              component={Link}
              to={floatingIpsListPath({
                cluster: vm.cluster,
                namespace: vm.namespace,
              })}
              size="xs"
              variant="subtle"
              leftSection={<IconWorldWww size={14} />}
            >
              All floating IPs
            </Button>
            {vpcPrefill && (
              <Button
                component={Link}
                to={floatingIpCreatePath({
                  cluster: vpcPrefill.cluster,
                  namespace: vpcPrefill.namespace,
                  vpc: vpcPrefill.name,
                  targetVm: vm.name,
                })}
                size="xs"
                variant="light"
                color="teal"
                leftSection={<IconPlus size={14} />}
              >
                Associate
              </Button>
            )}
          </Group>
        }
      >
        <Text size="sm" c="dimmed" mb="sm">
          Public addresses mapped through a router external gateway to this VM.
        </Text>
        {floatingIps.length === 0 ? (
          <Text size="sm" c="dimmed">
            {vpcPrefill
              ? "No floating IPs associated with this VM."
              : "Attach this VM to a VPC whose shared router has an external gateway to use floating IPs."}
          </Text>
        ) : (
          <Table.ScrollContainer
            className="kmc-table-scroll"
            minWidth={480}
            type="native"
          >
            <Table className="kmc-table" verticalSpacing="xs" withRowBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Public</Table.Th>
                  <Table.Th>Private</Table.Th>
                  <Table.Th>VPC</Table.Th>
                  <Table.Th>Agent</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {floatingIps.map((f) => (
                  <Table.Tr key={`${f.vpcName}/${f.id}`}>
                    <Table.Td>
                      <Code>
                        {f.public}/{f.prefix}
                      </Code>
                    </Table.Td>
                    <Table.Td>
                      <Code>{f.private}</Code>
                    </Table.Td>
                    <Table.Td>
                      <ResourceLink
                        to={vpcPath({
                          cluster: f.cluster,
                          namespace: f.namespace,
                          name: f.vpcName,
                        })}
                      >
                        {f.vpcName}
                      </ResourceLink>
                    </Table.Td>
                    <Table.Td>
                      {f.agentStatus ? <StatusBadge status={f.agentStatus} /> : "—"}
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="orange"
                        disabled={busy}
                        onClick={() => setDisassociateTarget(f)}
                      >
                        Disassociate
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </DetailSection>

      <DetailSection
        title="Ingresses"
        actions={
          <Group gap="xs">
            <Button
              component={Link}
              to={ingressesListPath({
                cluster: vm.cluster,
                namespace: vm.namespace,
              })}
              size="xs"
              variant="subtle"
              leftSection={<IconWorld size={14} />}
            >
              All ingresses
            </Button>
            <Button
              component={Link}
              to="/ingresses/create"
              size="xs"
              variant="light"
              color="grape"
              leftSection={<IconPlus size={14} />}
            >
              Create
            </Button>
          </Group>
        }
      >
        <Text size="sm" c="dimmed" mb="sm">
          HTTP(S) routes exposing this VM on the pod network.
        </Text>
        {ingresses.length === 0 ? (
          <Text size="sm" c="dimmed">
            No Ingresses bound to this VM.
          </Text>
        ) : (
          <Table.ScrollContainer
            className="kmc-table-scroll"
            minWidth={480}
            type="native"
          >
            <Table className="kmc-table" verticalSpacing="xs" withRowBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Hosts</Table.Th>
                  <Table.Th>Class</Table.Th>
                  <Table.Th>Age</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {ingresses.map((ing) => (
                  <Table.Tr key={ing.name}>
                    <Table.Td>
                      <ResourceLink to={ingressPath(ing)}>{ing.name}</ResourceLink>
                      {ing.address ? (
                        <Text size="xs" c="dimmed">
                          {ing.address}
                        </Text>
                      ) : null}
                    </Table.Td>
                    <Table.Td>
                      {ing.hosts.length === 0 ? (
                        <Text size="sm" c="dimmed">
                          —
                        </Text>
                      ) : (
                        <Group gap="xs" wrap="wrap">
                          {ing.hosts.map((host) => {
                            const tls = ing.tlsHosts.includes(host);
                            return (
                              <Anchor
                                key={host}
                                href={ingressHostUrl(host, ing.tlsHosts)}
                                target="_blank"
                                rel="noopener noreferrer"
                                size="sm"
                              >
                                {host}
                                {tls ? (
                                  <Text component="span" size="xs" c="dimmed" ml={4}>
                                    (TLS)
                                  </Text>
                                ) : null}
                              </Anchor>
                            );
                          })}
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {ing.className ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {formatAge(ing.age)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </DetailSection>

      <ConfirmActionModal
        opened={disassociateTarget != null}
        onClose={() => setDisassociateTarget(null)}
        title="Disassociate floating IP"
        confirmLabel="Disassociate"
        confirmColor="orange"
        loading={busy}
        onConfirm={() => {
          if (!disassociateTarget) return;
          fetcher.submit(
            {
              intent: "disassociate-fip",
              vpcName: disassociateTarget.vpcName,
              idOrPublic: disassociateTarget.id,
            },
            { method: "post" },
          );
          setDisassociateTarget(null);
        }}
        message={
          disassociateTarget ? (
            <>
              Unmap{" "}
              <Code>
                {disassociateTarget.public} → {disassociateTarget.private}
              </Code>{" "}
              on VPC <Code>{disassociateTarget.vpcName}</Code>? The public address stays
              reserved (held) until released from the floating IPs list or VPC page.
            </>
          ) : (
            ""
          )
        }
      />
    </Stack>
  );
}
