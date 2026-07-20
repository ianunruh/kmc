import {
  Alert,
  Button,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconPlus, IconRefresh, IconSearch } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useRevalidator } from "react-router";
import type { Route } from "./+types/home";
import { VmTable } from "~/components/VmTable";
import {
  deleteVm,
  listVms,
  startVm,
  stopVm,
} from "~/lib/k8s/vms.server";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Virtual Machines · kmc" },
    { name: "description", content: "Multi-cluster KubeVirt console" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const cluster = url.searchParams.get("cluster") ?? undefined;
  return listVms(cluster || undefined);
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const cluster = String(form.get("cluster") ?? "");
  const namespace = String(form.get("namespace") ?? "");
  const name = String(form.get("name") ?? "");

  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing cluster, namespace, or name", intent };
  }

  try {
    if (intent === "stop") {
      await stopVm(cluster, namespace, name);
    } else if (intent === "start") {
      await startVm(cluster, namespace, name);
    } else if (intent === "delete") {
      await deleteVm(cluster, namespace, name);
    } else {
      return { ok: false, error: `Unknown intent: ${intent}`, intent };
    }
    return { ok: true, intent };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      intent,
    };
  }
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const revalidator = useRevalidator();
  const [search, setSearch] = useState("");
  const [clusterFilter, setClusterFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }, 10_000);
    return () => window.clearInterval(id);
  }, [revalidator]);

  const statuses = useMemo(() => {
    const set = new Set(items.map((v) => v.status));
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((vm) => {
      if (clusterFilter && vm.cluster !== clusterFilter) return false;
      if (statusFilter && vm.status !== statusFilter) return false;
      if (!q) return true;
      return (
        vm.name.toLowerCase().includes(q) ||
        vm.namespace.toLowerCase().includes(q) ||
        vm.cluster.toLowerCase().includes(q)
      );
    });
  }, [items, search, clusterFilter, statusFilter]);

  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2} size="h3">
            Virtual Machines
          </Title>
          <Text size="sm" c="dimmed">
            {filtered.length} shown · {items.length} total across{" "}
            {clusters.filter((c) => c.reachable).length} cluster
            {clusters.filter((c) => c.reachable).length === 1 ? "" : "s"}
          </Text>
        </div>
        <Group>
          <Button
            variant="default"
            leftSection={<IconRefresh size={16} />}
            onClick={() => revalidator.revalidate()}
            loading={revalidator.state === "loading"}
          >
            Refresh
          </Button>
          <Button
            component={Link}
            to="/vms/create"
            leftSection={<IconPlus size={16} />}
          >
            Create VM
          </Button>
        </Group>
      </Group>

      {unreachable.map((c) => (
        <Alert key={c.id} color="red" title={`${c.id}: unreachable`} variant="light">
          {c.error}
        </Alert>
      ))}

      <Paper
        p="md"
        radius="sm"
        style={{
          background: "#12151a",
          border: "1px solid #1e242c",
        }}
      >
        <Group mb="md" align="flex-end">
          <TextInput
            placeholder="Search name, namespace, cluster…"
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <Select
            placeholder="Cluster"
            clearable
            data={clusters.map((c) => c.id)}
            value={clusterFilter}
            onChange={setClusterFilter}
            w={180}
          />
          <Select
            placeholder="Status"
            clearable
            data={statuses}
            value={statusFilter}
            onChange={setStatusFilter}
            w={180}
          />
        </Group>

        <VmTable vms={filtered} />
      </Paper>
    </Stack>
  );
}
