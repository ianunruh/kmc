import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Menu,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconDotsVertical,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/object-storage._index";
import { StatusBadge } from "~/ui/status-badge";
import {
  BulkActionBar,
  ConfirmBulkDeleteModal,
  ConfirmDeleteModal,
  ConsolePaper,
  FilterBar,
  PageHeader,
  ResourceLink,
  ResourceTable,
  Table,
} from "~/ui";
import {
  notifyActionError,
  notifyActionSuccess,
  notifyBulkResult,
} from "~/lib/action-feedback";
import {
  bulkTargetsJson,
  isBulkActionResult,
  namespacedKey,
  parseNamespacedBulkTargets,
  runBulkAction,
} from "~/lib/bulk-action";
import { actionFailure } from "~/lib/errors";
import {
  formatAge,
  objectStorageCreatePath,
  objectStorageListPath,
  objectStoragePath,
} from "~/lib/format";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import {
  deleteObjectBucket,
  listObjectBuckets,
} from "~/object-storage/object-storage.server";
import { useRefresh } from "~/lib/refresh";
import type { BulkActionResult, ObjectBucketSummary } from "~/lib/types";
import { resourceKey, useRowSelection } from "~/lib/use-row-selection";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Object Storage · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return listObjectBuckets(clusterFromRequest(request));
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "bulk-delete") {
    const { targets, error } = parseNamespacedBulkTargets(form.get("targets"));
    if (error || !targets) {
      return {
        ok: false,
        error: error ?? "Missing targets",
        intent,
        summary: { total: 0, succeeded: 0, skipped: 0, failed: 0 },
        results: [],
      };
    }
    return runBulkAction(intent, targets, namespacedKey, async (t) => {
      await deleteObjectBucket(t.cluster, t.namespace, t.name);
    });
  }

  const cluster = String(form.get("cluster") ?? "");
  const namespace = String(form.get("namespace") ?? "");
  const name = String(form.get("name") ?? "");

  if (intent !== "delete") {
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  }
  if (!cluster || !namespace || !name) {
    return { ok: false, error: "Missing identity", intent };
  }
  try {
    await deleteObjectBucket(cluster, namespace, name);
    return { ok: true, intent };
  } catch (err) {
    return actionFailure("object-storage.delete", err, {
      intent,
      cluster,
      namespace,
      name,
    });
  }
}

type ActionResult =
  | { ok?: boolean; error?: string; intent?: string }
  | BulkActionResult;

export default function ObjectStoragePage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [deleteTarget, setDeleteTarget] = useState<ObjectBucketSummary | null>(
    null,
  );
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const namespaces = useMemo(() => {
    const set = new Set(items.map((b) => b.namespace));
    return Array.from(set).sort();
  }, [items]);

  const statuses = useMemo(() => {
    const set = new Set(items.map((b) => b.status));
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((b) => {
      if (filters.cluster && b.cluster !== filters.cluster) return false;
      if (filters.namespace && b.namespace !== filters.namespace) return false;
      if (filters.status && b.status !== filters.status) return false;
      return matchesQuery(qDraft, [
        b.name,
        b.namespace,
        b.cluster,
        b.status,
        b.phase,
        b.bucketName,
        b.storageClass,
        b.objectBucketName,
        b.managedByKmc ? "kmc managed" : undefined,
      ]);
    });
  }, [items, filters.cluster, filters.namespace, filters.status, qDraft]);

  const visibleKeys = useMemo(() => filtered.map(resourceKey), [filtered]);
  const {
    selected,
    selectedCount,
    allSelected,
    someSelected,
    isSelected,
    toggle,
    toggleAllVisible,
    clear,
  } = useRowSelection(visibleKeys);

  const selectedItems = useMemo(
    () => filtered.filter((b) => selected.has(resourceKey(b))),
    [filtered, selected],
  );

  useFetcherResult(fetcher, (data) => {
    if (isBulkActionResult(data)) {
      if (data.error && data.results.length === 0) {
        notifyActionError("Bulk action failed", data.error, {
          intent: data.intent,
        });
        return;
      }
      notifyBulkResult("deleted", data.summary, data.results);
      clear();
      setBulkDeleteOpen(false);
      refreshNow();
      return;
    }
    if (data.error) {
      notifyActionError("Action failed", data.error, { intent: data.intent });
    } else if (data.ok) {
      notifyActionSuccess("Done", "Object bucket claim deleted");
      refreshNow();
    }
  });

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Object Storage"
        description={`${filtered.length} shown · ${items.length} total · S3 buckets via ObjectBucketClaim (Ceph RGW)`}
        actions={
          <Button
            component={Link}
            to={objectStorageCreatePath()}
            leftSection={<IconPlus size={16} />}
          >
            Create bucket
          </Button>
        }
      />

      {unreachable.map((c) => (
        <Alert key={c.id} color="red" title={`${c.id}: unreachable`} variant="light">
          {c.error}
        </Alert>
      ))}

      <ConsolePaper>
        <FilterBar>
          <TextInput
            placeholder="Search name, bucket, storage class…"
            leftSection={<IconSearch size={14} />}
            value={qDraft}
            onChange={(e) => setQ(e.currentTarget.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <Select
            placeholder="Cluster"
            clearable
            data={clusters.map((c) => c.id)}
            value={filters.cluster}
            onChange={(v) => setFilter("cluster", v)}
            w={180}
          />
          <Select
            placeholder="Namespace"
            clearable
            searchable
            data={namespaces}
            value={filters.namespace}
            onChange={(v) => setFilter("namespace", v)}
            w={180}
          />
          <Select
            placeholder="Status"
            clearable
            data={statuses}
            value={filters.status}
            onChange={(v) => setFilter("status", v)}
            w={160}
          />
        </FilterBar>

        <Stack gap="sm">
          <BulkActionBar
            selectedCount={selectedCount}
            onClear={clear}
            disabled={busy}
          >
            <Button
              size="xs"
              variant="light"
              color="red"
              leftSection={<IconTrash size={14} />}
              disabled={busy}
              onClick={() => setBulkDeleteOpen(true)}
            >
              Delete
            </Button>
          </BulkActionBar>

          <ResourceTable
            isEmpty={filtered.length === 0}
            emptyMessage="No ObjectBucketClaims found. Create one to provision an S3 bucket."
            headers={[
              <Checkbox
                key="select-all"
                aria-label="Select all visible"
                checked={allSelected}
                indeterminate={someSelected}
                disabled={busy || filtered.length === 0}
                onChange={() => toggleAllVisible()}
              />,
              "Name",
              "Cluster",
              "Namespace",
              "Status",
              "Bucket",
              "Storage class",
              "Age",
              "",
            ]}
          >
            {filtered.map((b) => {
              const key = resourceKey(b);
              return (
                <Table.Tr key={key} bg={isSelected(key) ? "dark.7" : undefined}>
                  <Table.Td w={40}>
                    <Checkbox
                      aria-label={`Select ${b.name}`}
                      checked={isSelected(key)}
                      disabled={busy}
                      onChange={() => toggle(key)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <ResourceLink to={objectStoragePath(b)}>
                        {b.name}
                      </ResourceLink>
                      {b.managedByKmc ? (
                        <Badge size="xs" variant="light" color="accent">
                          kmc
                        </Badge>
                      ) : null}
                    </Group>
                    {b.objectBucketName ? (
                      <Text size="xs" c="dimmed">
                        {b.objectBucketName}
                      </Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={objectStorageListPath({ cluster: b.cluster })}
                      dimmed
                    >
                      {b.cluster}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={objectStorageListPath({
                        cluster: b.cluster,
                        namespace: b.namespace,
                      })}
                      dimmed
                    >
                      {b.namespace}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={objectStorageListPath({
                        cluster: b.cluster,
                        status: b.status,
                      })}
                      underline="never"
                    >
                      <StatusBadge status={b.status} />
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" ff="monospace">
                      {b.bucketName ?? "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{b.storageClass ?? "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={b.age || "unknown"}>
                      <Text size="sm" c="dimmed">
                        {formatAge(b.age)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Menu shadow="md" width={180} position="bottom-end">
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`Actions for ${b.name}`}
                        >
                          <IconDotsVertical size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item component={Link} to={objectStoragePath(b)}>
                          Open
                        </Menu.Item>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          disabled={busy}
                          onClick={() => setDeleteTarget(b)}
                        >
                          Delete
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </ResourceTable>
        </Stack>
      </ConsolePaper>

      <ConfirmDeleteModal
        opened={deleteTarget != null}
        resourceName={deleteTarget?.name ?? ""}
        identity={
          deleteTarget
            ? `${deleteTarget.cluster}/${deleteTarget.namespace}/${deleteTarget.name}`
            : ""
        }
        title="Delete object bucket"
        confirmLabel="Delete claim"
        warning={
          deleteTarget && !deleteTarget.managedByKmc
            ? "This claim was not created by kmc. Deleting removes the ObjectBucketClaim and typically the underlying S3 bucket — data will be lost."
            : "Deletes the ObjectBucketClaim and typically the underlying S3 bucket (reclaimPolicy Delete). Data will be lost."
        }
        loading={busy}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          const target = deleteTarget;
          setDeleteTarget(null);
          fetcher.submit(
            {
              intent: "delete",
              cluster: target.cluster,
              namespace: target.namespace,
              name: target.name,
            },
            { method: "post" },
          );
        }}
      />

      <ConfirmBulkDeleteModal
        opened={bulkDeleteOpen}
        count={selectedItems.length}
        identities={selectedItems.map(resourceKey)}
        title={`Delete ${selectedItems.length} bucket${selectedItems.length === 1 ? "" : "s"}`}
        confirmLabel={`Delete ${selectedItems.length}`}
        warning="Deletes ObjectBucketClaim resources and typically their S3 buckets. Data will be lost."
        loading={busy}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit(
            {
              intent: "bulk-delete",
              targets: bulkTargetsJson(selectedItems),
            },
            { method: "post" },
          );
        }}
      />
    </Stack>
  );
}
