import {
  Alert,
  Anchor,
  Button,
  Code,
  Group,
  Stack,
  Table,
  Text,
  Badge,
} from "@mantine/core";
import {
  IconArrowsRightLeft,
  IconCloudComputing,
  IconPlus,
  IconWorld,
  IconWorldWww,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/vms.$cluster.$namespace.$name.networking";
import {
  ConfirmActionModal,
  ConfirmDeleteModal,
  CopyButton,
  CopyableValue,
  DetailSection,
  ResourceLink,
} from "~/ui";
import { StatusBadge } from "~/ui/status-badge";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  floatingIpCreatePath,
  floatingIpDetailPath,
  floatingIpsListPath,
  formatAge,
  httpRouteCreatePath,
  httpRouteHostUrl,
  httpRoutePath,
  httpRoutesListPath,
  loadBalancerCreatePath,
  loadBalancerPath,
  loadBalancersListPath,
  portForwardCreatePath,
  portForwardDetailPath,
  portForwardsListPath,
  vpcPath,
} from "~/lib/format";
import type {
  BackendSummary,
  FloatingIpSummary,
  HttpRouteSummary,
  PortForwardSummary,
} from "~/lib/types";
import {
  deleteLoadBalancer,
  listLoadBalancersForVm,
} from "~/backends/backends.server";
import { deleteHttpRoute, listHttpRoutesForVm } from "~/httproutes/httproutes.server";
import {
  deletePortForward,
  disassociateFloatingIp,
  listFloatingIpsForVm,
  listPortForwardsForVm,
} from "~/vpcs/vpcs.server";
import { getVm } from "~/vms/vms.server";
import { addressFromIpv4Annotation } from "~/lib/ipam/cidr";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { useVmDetail, type VmDetailActionResult } from "~/vms/vm-detail-shared";
import { tracedLoader } from "~/lib/request-traces.server";

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
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

  let portForwards: PortForwardSummary[] = [];
  try {
    portForwards = await listPortForwardsForVm(cluster, namespace, name, privateAddrs);
  } catch {
    portForwards = [];
  }

  let httpRoutes: HttpRouteSummary[] = [];
  try {
    httpRoutes = await listHttpRoutesForVm(cluster, namespace, name);
  } catch {
    httpRoutes = [];
  }

  let loadBalancers: BackendSummary[] = [];
  try {
    loadBalancers = await listLoadBalancersForVm(cluster, namespace, name);
  } catch {
    loadBalancers = [];
  }

  const vpcPrefill = vm.networks.find((n) => n.vpc)?.vpc;
  const hasPodNetwork =
    vm.networks.length === 0 ||
    vm.networks.some((n) => n.pod && !n.multusNetworkName);

  return {
    floatingIps,
    portForwards,
    httpRoutes,
    loadBalancers,
    hasPodNetwork,
    vpcPrefill: vpcPrefill
      ? {
          cluster,
          namespace: vpcPrefill.namespace,
          name: vpcPrefill.name,
        }
      : null,
  };
});

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
    if (intent === "delete-port-forward") {
      const vpcName = String(form.get("vpcName") ?? "").trim();
      const id = String(form.get("id") ?? "").trim();
      if (!vpcName || !id) {
        return { ok: false, error: "Missing port forward identity", intent };
      }
      await deletePortForward({
        cluster,
        namespace,
        vpcName,
        id,
      });
      return { ok: true, intent };
    }
    if (intent === "delete-http-route") {
      const routeName = String(form.get("name") ?? "").trim();
      if (!routeName) {
        return { ok: false, error: "Missing HTTPRoute name", intent };
      }
      await deleteHttpRoute(cluster, namespace, routeName);
      return { ok: true, intent };
    }
    if (intent === "delete-load-balancer") {
      const lbName = String(form.get("name") ?? "").trim();
      if (!lbName) {
        return { ok: false, error: "Missing load balancer name", intent };
      }
      await deleteLoadBalancer(cluster, namespace, lbName);
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
  const {
    floatingIps,
    portForwards,
    httpRoutes,
    loadBalancers,
    hasPodNetwork,
    vpcPrefill,
  } = loaderData;
  const fetcher = useFetcher<VmDetailActionResult>();
  const { refreshNow } = useRefresh();
  const [disassociateTarget, setDisassociateTarget] = useState<FloatingIpSummary | null>(
    null,
  );
  const [deletePfTarget, setDeletePfTarget] = useState<PortForwardSummary | null>(null);
  const [deleteRouteTarget, setDeleteRouteTarget] = useState<HttpRouteSummary | null>(null);
  const [deleteLbTarget, setDeleteLbTarget] = useState<BackendSummary | null>(null);
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
    if (data.ok && data.intent === "delete-port-forward") {
      notifyActionSuccess("Done", "Port forward deleted");
      refreshNow();
    }
    if (data.ok && data.intent === "delete-http-route") {
      notifyActionSuccess("Done", "HTTPRoute deleted");
      refreshNow();
    }
    if (data.ok && data.intent === "delete-load-balancer") {
      notifyActionSuccess("Done", "Load balancer deleted");
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
                      {net.mac ? (
                        <CopyableValue value={net.mac} size="xs" />
                      ) : (
                        <Text size="sm" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {net.ipAddresses?.length ? (
                        <CopyableValue
                          value={net.ipAddresses.join(", ")}
                          display={net.ipAddresses.join(", ")}
                          size="xs"
                        />
                      ) : (
                        <Text size="sm" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </DetailSection>

      <Alert color="gray" variant="light" title="How to expose this VM">
        <Stack gap={4}>
          <Text size="sm">
            <strong>VPC plane</strong> (Multus + shared router): Floating IP = full public
            address; Port forward = single public port. Needs a VPC with an external
            gateway on the router.
          </Text>
          <Text size="sm">
            <strong>Pod plane</strong> (masquerade NIC): HTTP Route = HTTP(S) host/path
            via Gateway API; Load balancer = L4 VIP (TCP/UDP). The guest must listen on
            the pod interface.
          </Text>
        </Stack>
      </Alert>

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
              <Group gap="xs">
                <Button
                  component={Link}
                  to={floatingIpCreatePath({
                    cluster: vpcPrefill.cluster,
                    namespace: vpcPrefill.namespace,
                    vpc: vpcPrefill.name,
                    mode: "reserve",
                  })}
                  size="xs"
                  variant="default"
                  leftSection={<IconPlus size={14} />}
                >
                  Reserve
                </Button>
                <Button
                  component={Link}
                  to={floatingIpCreatePath({
                    cluster: vpcPrefill.cluster,
                    namespace: vpcPrefill.namespace,
                    vpc: vpcPrefill.name,
                    targetVm: vm.name,
                    mode: "associate",
                  })}
                  size="xs"
                  variant="light"
                  color="teal"
                  leftSection={<IconPlus size={14} />}
                >
                  Associate
                </Button>
              </Group>
            )}
          </Group>
        }
      >
        <Text size="sm" c="dimmed" mb="sm">
          VPC plane · public address mapped through the router external gateway to this
          VM (any protocol).
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
                      <Group gap={4} wrap="nowrap">
                        <ResourceLink to={floatingIpDetailPath(f)}>
                          <Code>
                            {f.public}/{f.prefix}
                          </Code>
                        </ResourceLink>
                        <CopyButton value={f.public} size="xs" />
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      {f.private ? (
                        <CopyableValue value={f.private} />
                      ) : (
                        <Text size="sm" c="dimmed">
                          —
                        </Text>
                      )}
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
        title="Port Forwards"
        actions={
          <Group gap="xs">
            <Button
              component={Link}
              to={portForwardsListPath({
                cluster: vm.cluster,
                namespace: vm.namespace,
              })}
              size="xs"
              variant="subtle"
              leftSection={<IconArrowsRightLeft size={14} />}
            >
              All port forwards
            </Button>
            {vpcPrefill && (
              <Button
                component={Link}
                to={portForwardCreatePath({
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
                Create
              </Button>
            )}
          </Group>
        }
      >
        <Text size="sm" c="dimmed" mb="sm">
          VPC plane · public port mapping through the router (without a full floating IP).
        </Text>
        {portForwards.length === 0 ? (
          <Text size="sm" c="dimmed">
            {vpcPrefill
              ? "No port forwards targeting this VM."
              : "Attach this VM to a VPC whose shared router has an external gateway to use port forwards."}
          </Text>
        ) : (
          <Table.ScrollContainer
            className="kmc-table-scroll"
            minWidth={520}
            type="native"
          >
            <Table className="kmc-table" verticalSpacing="xs" withRowBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Public</Table.Th>
                  <Table.Th>Protocol</Table.Th>
                  <Table.Th>Private</Table.Th>
                  <Table.Th>VPC</Table.Th>
                  <Table.Th>Agent</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {portForwards.map((pf) => (
                  <Table.Tr key={`${pf.vpcName}/${pf.id}`}>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <ResourceLink to={portForwardDetailPath(pf)}>
                          <Code>
                            {pf.public}:{pf.publicPort}
                          </Code>
                        </ResourceLink>
                        <CopyButton
                          value={`${pf.public}:${pf.publicPort}`}
                          size="xs"
                        />
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant="light" color="blue">
                        {pf.protocol.toUpperCase()}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <CopyableValue
                        value={`${pf.private}:${pf.privatePort}`}
                        display={`${pf.private}:${pf.privatePort}`}
                      />
                    </Table.Td>
                    <Table.Td>
                      <ResourceLink
                        to={vpcPath({
                          cluster: pf.cluster,
                          namespace: pf.namespace,
                          name: pf.vpcName,
                        })}
                      >
                        {pf.vpcName}
                      </ResourceLink>
                    </Table.Td>
                    <Table.Td>
                      {pf.agentStatus ? <StatusBadge status={pf.agentStatus} /> : "—"}
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        disabled={busy}
                        onClick={() => setDeletePfTarget(pf)}
                      >
                        Delete
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
        title="HTTP Routes"
        actions={
          <Group gap="xs">
            <Button
              component={Link}
              to={httpRoutesListPath({
                cluster: vm.cluster,
                namespace: vm.namespace,
              })}
              size="xs"
              variant="subtle"
              leftSection={<IconWorld size={14} />}
            >
              All HTTP routes
            </Button>
            <Button
              component={Link}
              to={httpRouteCreatePath({
                cluster: vm.cluster,
                namespace: vm.namespace,
                vmName: vm.name,
              })}
              size="xs"
              variant="light"
              color="teal"
              leftSection={<IconPlus size={14} />}
              disabled={!hasPodNetwork}
              title={
                hasPodNetwork
                  ? undefined
                  : "Guest needs a pod/masquerade NIC for HTTPRoute"
              }
            >
              Create
            </Button>
          </Group>
        }
      >
        <Text size="sm" c="dimmed" mb="sm">
          Pod plane · HTTP(S) routes via ClusterIP Service + HTTPRoute (Gateway API).
        </Text>
        {!hasPodNetwork ? (
          <Alert color="yellow" variant="light" title="No pod network" mb="sm">
            This VM is Multus-only. HTTPRoute selects the virt-launcher pod IP — enable
            “Include pod network” on the VM (or recreate dual-home) before exposing.
          </Alert>
        ) : null}
        {httpRoutes.length === 0 ? (
          <Text size="sm" c="dimmed">
            No HTTPRoutes bound to this VM.
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
                  <Table.Th>Endpoints</Table.Th>
                  <Table.Th>Age</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {httpRoutes.map((route) => (
                  <Table.Tr key={route.name}>
                    <Table.Td>
                      <ResourceLink to={httpRoutePath(route)}>{route.name}</ResourceLink>
                      {route.address ? (
                        <CopyableValue value={route.address} size="xs" />
                      ) : null}
                    </Table.Td>
                    <Table.Td>
                      {route.hosts.length === 0 ? (
                        <Text size="sm" c="dimmed">
                          —
                        </Text>
                      ) : (
                        <Group gap="xs" wrap="wrap">
                          {route.hosts.map((host) => {
                            const https = route.httpsHosts.includes(host);
                            const url = httpRouteHostUrl(host, route.httpsHosts);
                            return (
                              <Group key={host} gap={2} wrap="nowrap">
                                <Anchor
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  size="sm"
                                >
                                  {host}
                                  {https ? (
                                    <Text component="span" size="xs" c="dimmed" ml={4}>
                                      (HTTPS)
                                    </Text>
                                  ) : null}
                                </Anchor>
                                <CopyButton value={url} label="Copy URL" size="xs" />
                              </Group>
                            );
                          })}
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text
                        size="sm"
                        c={
                          route.endpointsTotal != null && (route.endpointsReady ?? 0) === 0
                            ? "orange"
                            : "dimmed"
                        }
                      >
                        {route.endpointsTotal != null
                          ? `${route.endpointsReady ?? 0}/${route.endpointsTotal}`
                          : "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {formatAge(route.age)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        disabled={busy}
                        onClick={() => setDeleteRouteTarget(route)}
                      >
                        Delete
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
        title="Load Balancers"
        actions={
          <Group gap="xs">
            <Button
              component={Link}
              to={loadBalancersListPath({
                cluster: vm.cluster,
                namespace: vm.namespace,
              })}
              size="xs"
              variant="subtle"
              leftSection={<IconCloudComputing size={14} />}
            >
              All load balancers
            </Button>
            <Button
              component={Link}
              to={loadBalancerCreatePath({
                cluster: vm.cluster,
                namespace: vm.namespace,
                vmName: vm.name,
              })}
              size="xs"
              variant="light"
              color="teal"
              leftSection={<IconPlus size={14} />}
              disabled={!hasPodNetwork}
              title={
                hasPodNetwork
                  ? undefined
                  : "Guest needs a pod/masquerade NIC for LoadBalancer"
              }
            >
              Create
            </Button>
          </Group>
        }
      >
        <Text size="sm" c="dimmed" mb="sm">
          Pod plane · L4 Service type LoadBalancer (MetalLB / cloud VIP).
        </Text>
        {!hasPodNetwork ? (
          <Alert color="yellow" variant="light" title="No pod network" mb="sm">
            Load balancers select virt-launcher pod IPs. Dual-home this VM before
            creating a VIP.
          </Alert>
        ) : null}
        {loadBalancers.length === 0 ? (
          <Text size="sm" c="dimmed">
            No load balancers select this VM.
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
                  <Table.Th>External</Table.Th>
                  <Table.Th>Ports</Table.Th>
                  <Table.Th>Endpoints</Table.Th>
                  <Table.Th>Age</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {loadBalancers.map((lb) => (
                  <Table.Tr key={lb.name}>
                    <Table.Td>
                      <ResourceLink to={loadBalancerPath(lb)}>
                        {lb.name}
                      </ResourceLink>
                    </Table.Td>
                    <Table.Td>
                      {lb.externalAddress ? (
                        <CopyableValue value={lb.externalAddress} />
                      ) : (
                        <Badge size="sm" variant="light" color="yellow">
                          Pending
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {lb.ports.length > 0
                          ? lb.ports
                              .map(
                                (p) =>
                                  `${p.port}→${p.targetPort}/${p.protocol ?? "TCP"}`,
                              )
                              .join(", ")
                          : "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text
                        size="sm"
                        c={
                          lb.endpointsTotal != null && (lb.endpointsReady ?? 0) === 0
                            ? "orange"
                            : "dimmed"
                        }
                      >
                        {lb.endpointsTotal != null
                          ? `${lb.endpointsReady ?? 0}/${lb.endpointsTotal}`
                          : "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {formatAge(lb.age)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        disabled={busy}
                        onClick={() => setDeleteLbTarget(lb)}
                      >
                        Delete
                      </Button>
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

      <ConfirmActionModal
        opened={deletePfTarget != null}
        onClose={() => setDeletePfTarget(null)}
        title="Delete port forward"
        confirmLabel="Delete"
        confirmColor="red"
        loading={busy}
        onConfirm={() => {
          if (!deletePfTarget) return;
          fetcher.submit(
            {
              intent: "delete-port-forward",
              vpcName: deletePfTarget.vpcName,
              id: deletePfTarget.id,
            },
            { method: "post" },
          );
          setDeletePfTarget(null);
        }}
        message={
          deletePfTarget ? (
            <>
              Remove{" "}
              <Code>
                {deletePfTarget.protocol.toUpperCase()} {deletePfTarget.public}:
                {deletePfTarget.publicPort} → {deletePfTarget.private}:
                {deletePfTarget.privatePort}
              </Code>
              ?
            </>
          ) : (
            ""
          )
        }
      />

      <ConfirmDeleteModal
        opened={deleteRouteTarget != null}
        resourceName={deleteRouteTarget?.name ?? null}
        identity={
          deleteRouteTarget
            ? `${deleteRouteTarget.cluster}/${deleteRouteTarget.namespace}/${deleteRouteTarget.name}`
            : null
        }
        title="Delete HTTP Route"
        confirmLabel="Delete HTTP Route"
        warning="Also deletes the companion ClusterIP Service when kmc owns it. VirtualMachines are not deleted."
        loading={busy}
        onClose={() => setDeleteRouteTarget(null)}
        onConfirm={() => {
          if (!deleteRouteTarget) return;
          fetcher.submit(
            {
              intent: "delete-http-route",
              name: deleteRouteTarget.name,
            },
            { method: "post" },
          );
          setDeleteRouteTarget(null);
        }}
      />

      <ConfirmDeleteModal
        opened={deleteLbTarget != null}
        resourceName={deleteLbTarget?.name ?? null}
        identity={
          deleteLbTarget
            ? `${deleteLbTarget.cluster}/${deleteLbTarget.namespace}/${deleteLbTarget.name}`
            : null
        }
        title="Delete load balancer"
        confirmLabel="Delete"
        warning="Deletes the LoadBalancer Service. Group membership labels are cleared. VirtualMachines are not deleted."
        loading={busy}
        onClose={() => setDeleteLbTarget(null)}
        onConfirm={() => {
          if (!deleteLbTarget) return;
          fetcher.submit(
            {
              intent: "delete-load-balancer",
              name: deleteLbTarget.name,
            },
            { method: "post" },
          );
          setDeleteLbTarget(null);
        }}
      />
    </Stack>
  );
}
