import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
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
  IconRocket,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/images._index";
import { StatusBadge } from "~/ui/status-badge";
import {
  BulkActionBar,
  ClampedText,
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
  clusterScopedKey,
  isBulkActionResult,
  parseClusterBulkTargets,
  runBulkAction,
} from "~/lib/bulk-action";
import { actionFailure } from "~/lib/errors";
import {
  formatAge,
  imagePath,
  imagesListPath,
  vmCreateFromImagePath,
} from "~/lib/format";
import { clusterFromRequest } from "~/lib/search-params";
import { matchesQuery, useListFilters } from "~/lib/use-list-filters";
import { deleteImage, listImages } from "~/images/images.server";
import { useRefresh } from "~/lib/refresh";
import type { BulkActionResult, ImageSummary } from "~/lib/types";
import { clusterResourceKey, useRowSelection } from "~/lib/use-row-selection";
import { useFetcherResult } from "~/lib/use-fetcher-result";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Images · kmc" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return listImages(clusterFromRequest(request));
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "bulk-delete") {
    const { targets, error } = parseClusterBulkTargets(form.get("targets"));
    if (error || !targets) {
      return {
        ok: false,
        error: error ?? "Missing targets",
        intent,
        summary: { total: 0, succeeded: 0, skipped: 0, failed: 0 },
        results: [],
      };
    }
    return runBulkAction(intent, targets, clusterScopedKey, async (t) => {
      await deleteImage(t.cluster, t.name);
    });
  }

  const cluster = String(form.get("cluster") ?? "");
  const name = String(form.get("name") ?? "");

  if (intent !== "delete") {
    return { ok: false, error: `Unknown intent: ${intent}`, intent };
  }
  if (!cluster || !name) {
    return { ok: false, error: "Missing identity", intent };
  }
  try {
    await deleteImage(cluster, name);
    return { ok: true, intent };
  } catch (err) {
    return actionFailure("image.delete", err, {
      intent,
      cluster,
      name,
    });
  }
}

type ActionResult = { ok?: boolean; error?: string; intent?: string } | BulkActionResult;

export default function ImagesPage({ loaderData }: Route.ComponentProps) {
  const { items, clusters } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const { refreshNow } = useRefresh();
  const { filters, qDraft, setQ, setFilter } = useListFilters();
  const [deleteTarget, setDeleteTarget] = useState<ImageSummary | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const filtered = useMemo(() => {
    return items.filter((img) => {
      if (filters.cluster && img.cluster !== filters.cluster) return false;
      if (filters.phase && img.phase !== filters.phase) return false;
      return matchesQuery(qDraft, [
        img.name,
        img.cluster,
        img.phase,
        img.preference,
        img.sourceKind,
        img.sourceDetail,
        img.storageClass,
      ]);
    });
  }, [items, filters.cluster, filters.phase, qDraft]);

  const visibleKeys = useMemo(() => filtered.map(clusterResourceKey), [filtered]);
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
    () => filtered.filter((img) => selected.has(clusterResourceKey(img))),
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
      notifyActionSuccess("Done", "Image deleted");
      refreshNow();
    }
  });

  const phases = useMemo(() => {
    const set = new Set(items.map((img) => img.phase));
    return Array.from(set).sort();
  }, [items]);

  const busy = fetcher.state !== "idle";
  const unreachable = clusters.filter((c) => !c.reachable);

  return (
    <Stack gap="md">
      <PageHeader
        title="Images"
        description={`${filtered.length} shown · ${items.length} total · golden disks in the image namespace`}
        actions={
          <Button
            component={Link}
            to="/images/create"
            leftSection={<IconPlus size={16} />}
          >
            Import Image
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
            placeholder="Search name, preference, URL…"
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
            placeholder="Phase"
            clearable
            data={phases}
            value={filters.phase}
            onChange={(v) => setFilter("phase", v)}
            w={180}
          />
        </FilterBar>

        <Stack gap="sm">
          <BulkActionBar selectedCount={selectedCount} onClear={clear} disabled={busy}>
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
            emptyMessage="No golden images found. Import from HTTP or upload with virtctl."
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
              "Phase",
              "Size",
              "Preference",
              "Source",
              "Age",
              "",
            ]}
          >
            {filtered.map((img) => {
              const key = clusterResourceKey(img);
              const sizeLabel = img.capacity ?? img.size ?? "—";
              return (
                <Table.Tr key={key} bg={isSelected(key) ? "dark.7" : undefined}>
                  <Table.Td w={40}>
                    <Checkbox
                      aria-label={`Select ${img.name}`}
                      checked={isSelected(key)}
                      disabled={busy}
                      onChange={() => toggle(key)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink to={imagePath(img)}>{img.name}</ResourceLink>
                    {img.progress && img.progress !== "N/A" && (
                      <Text size="xs" c="dimmed">
                        {img.progress}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink to={imagesListPath({ cluster: img.cluster })} dimmed>
                      {img.cluster}
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <ResourceLink
                      to={imagesListPath({
                        cluster: img.cluster,
                        phase: img.phase,
                      })}
                      underline="never"
                    >
                      <StatusBadge status={img.phase} />
                    </ResourceLink>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{sizeLabel}</Text>
                    {img.storageClass && (
                      <Text size="xs" c="dimmed">
                        {img.storageClass}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c={img.preference ? undefined : "dimmed"}>
                      {img.preference ?? "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{img.sourceKind ?? "—"}</Text>
                    {img.sourceDetail && (
                      <ClampedText size="xs" c="dimmed" lineClamp={1}>
                        {img.sourceDetail}
                      </ClampedText>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {formatAge(img.age)}
                    </Text>
                  </Table.Td>
                  <Table.Td w={48}>
                    <Menu shadow="md" width={180} position="bottom-end">
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`Actions for ${img.name}`}
                        >
                          <IconDotsVertical size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {img.ready && (
                          <Menu.Item
                            component={Link}
                            to={vmCreateFromImagePath(img)}
                            leftSection={<IconRocket size={14} />}
                          >
                            Launch VM
                          </Menu.Item>
                        )}
                        {!img.ready && (
                          <Tooltip label="Image PVC is not Bound yet">
                            <Menu.Item disabled leftSection={<IconRocket size={14} />}>
                              Launch VM
                            </Menu.Item>
                          </Tooltip>
                        )}
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          disabled={busy}
                          onClick={() => setDeleteTarget(img)}
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
        opened={Boolean(deleteTarget)}
        resourceName={deleteTarget?.name ?? ""}
        identity={
          deleteTarget
            ? `${deleteTarget.cluster}/${deleteTarget.namespace}/${deleteTarget.name}`
            : ""
        }
        title="Delete image"
        confirmLabel="Delete image"
        warning="Deletes the DataVolume and backing PVC in the image namespace. Existing VMs that cloned this image are not affected."
        loading={busy}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          const { cluster, name } = deleteTarget;
          setDeleteTarget(null);
          fetcher.submit({ intent: "delete", cluster, name }, { method: "post" });
        }}
      />

      <ConfirmBulkDeleteModal
        opened={bulkDeleteOpen}
        count={selectedItems.length}
        identities={selectedItems.map(clusterResourceKey)}
        title={`Delete ${selectedItems.length} image${selectedItems.length === 1 ? "" : "s"}`}
        confirmLabel={`Delete ${selectedItems.length}`}
        warning="Deletes DataVolumes and backing PVCs in the image namespace. Existing VMs that cloned these images are not affected."
        loading={busy}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit(
            {
              intent: "bulk-delete",
              targets: bulkTargetsJson(
                selectedItems.map((img) => ({
                  cluster: img.cluster,
                  name: img.name,
                })),
              ),
            },
            { method: "post" },
          );
        }}
      />
    </Stack>
  );
}
