import { Badge, Button, Code, Group, Stack, Title } from "@mantine/core";
import {
  IconArrowLeft,
  IconLink,
  IconTrash,
  IconUnlink,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, Outlet, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/floating-ips.$cluster.$namespace.$name";
import {
  ConfirmActionModal,
  DetailTabs,
  ResourceIdentity,
  StatusBadge,
} from "~/ui";
import { notifyActionError, notifyActionSuccess } from "~/lib/action-feedback";
import { actionFailure } from "~/lib/errors";
import {
  detailTabPath,
  floatingIpCreatePath,
  floatingIpPath,
  floatingIpsListPath,
} from "~/lib/format";
import { useRefresh } from "~/lib/refresh";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import {
  disassociateFloatingIp,
  getFloatingIp,
  releaseFloatingIp,
} from "~/vpcs/vpcs.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.name ?? "Floating IP"} · Floating IP · kmc` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const fip = await getFloatingIp(cluster, namespace, name);
  return { fip };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing path params" };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fip = await getFloatingIp(cluster, namespace, name);

  if (intent === "disassociate") {
    try {
      await disassociateFloatingIp({
        cluster,
        namespace,
        vpcName: fip.vpcName,
        idOrPublic: fip.name,
      });
      return { ok: true, intent: "disassociate" };
    } catch (err) {
      return actionFailure("floatingIp.disassociate", err, {
        intent,
        cluster,
        namespace,
        name,
      });
    }
  }

  if (intent === "release") {
    try {
      await releaseFloatingIp({
        cluster,
        namespace,
        vpcName: fip.vpcName,
        idOrPublic: fip.name,
      });
      return redirect(floatingIpsListPath());
    } catch (err) {
      return actionFailure("floatingIp.release", err, {
        intent,
        cluster,
        namespace,
        name,
      });
    }
  }

  return { ok: false, error: `Unknown intent: ${intent}`, intent };
}

export default function FloatingIpDetailLayout({
  loaderData,
}: Route.ComponentProps) {
  const { fip } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const { refreshNow } = useRefresh();
  const [disassociateOpen, setDisassociateOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const base = floatingIpPath({
    cluster: fip.cluster,
    namespace: fip.namespace,
    name: fip.name,
  });

  useFetcherResult(fetcher, (data) => {
    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
      return;
    }
    if (data.ok) {
      if (data.intent === "disassociate") {
        notifyActionSuccess(
          "Done",
          "Floating IP disassociated — public address is held (not released)",
        );
      }
      refreshNow();
    }
  });

  const displayTitle = fip.public
    ? `${fip.public}${fip.prefix ? `/${fip.prefix}` : ""}`
    : fip.name;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Button
            component={Link}
            to={floatingIpsListPath()}
            variant="subtle"
            size="compact-sm"
            leftSection={<IconArrowLeft size={14} />}
            mb="xs"
          >
            Floating IPs
          </Button>
          <Group gap="sm" mb={4}>
            <Title order={2}>{displayTitle}</Title>
            <Badge
              size="sm"
              variant="light"
              color={fip.state === "associated" ? "teal" : "yellow"}
            >
              {fip.state}
            </Badge>
            {fip.phase ? <StatusBadge status={fip.phase} /> : null}
          </Group>
          <ResourceIdentity
            items={[
              {
                label: fip.cluster,
                to: floatingIpsListPath({ cluster: fip.cluster }),
              },
              {
                label: fip.namespace,
                to: floatingIpsListPath({
                  cluster: fip.cluster,
                  namespace: fip.namespace,
                }),
              },
            ]}
          />
        </div>
        <Group gap="xs">
          {fip.state === "held" ? (
            <Button
              component={Link}
              to={floatingIpCreatePath({
                cluster: fip.cluster,
                namespace: fip.namespace,
                vpc: fip.vpcName,
                publicIpv4: fip.public,
              })}
              variant="light"
              color="teal"
              leftSection={<IconLink size={16} />}
              disabled={busy}
            >
              Associate
            </Button>
          ) : (
            <Button
              variant="light"
              color="orange"
              leftSection={<IconUnlink size={16} />}
              disabled={busy}
              onClick={() => setDisassociateOpen(true)}
            >
              Disassociate
            </Button>
          )}
          <Button
            color="red"
            variant="light"
            leftSection={<IconTrash size={16} />}
            disabled={busy}
            onClick={() => setReleaseOpen(true)}
          >
            Release
          </Button>
        </Group>
      </Group>

      <DetailTabs
        items={[
          { label: "Overview", to: detailTabPath(base, "overview"), end: true },
          { label: "Events", to: detailTabPath(base, "events") },
          { label: "YAML", to: detailTabPath(base, "yaml") },
        ]}
      />

      <Outlet />

      <ConfirmActionModal
        opened={disassociateOpen}
        onClose={() => setDisassociateOpen(false)}
        title="Disassociate floating IP"
        confirmLabel="Disassociate"
        confirmColor="orange"
        loading={busy}
        onConfirm={() => {
          fetcher.submit({ intent: "disassociate" }, { method: "post" });
          setDisassociateOpen(false);
        }}
        message={
          <>
            Unmap this floating IP from{" "}
            {fip.private ? <Code>{fip.private}</Code> : "its private target"}? The
            public address stays reserved (held) for this VPC until you release it.
          </>
        }
      />

      <ConfirmActionModal
        opened={releaseOpen}
        onClose={() => setReleaseOpen(false)}
        title="Release floating IP"
        confirmLabel="Release"
        confirmColor="red"
        loading={busy}
        onConfirm={() => {
          fetcher.submit({ intent: "release" }, { method: "post" });
          setReleaseOpen(false);
        }}
        message={
          <>
            Return <Code>{fip.public || fip.name}</Code> to the public IP pool?
            {fip.state === "associated" && fip.private ? (
              <>
                {" "}
                This also drops the mapping to <Code>{fip.private}</Code>.
              </>
            ) : null}{" "}
            The address can be allocated again after the router agent reconciles.
          </>
        }
      />
    </Stack>
  );
}
