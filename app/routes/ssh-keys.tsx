import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Code,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { IconKey, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";
import type { Route } from "./+types/ssh-keys";
import {
  notifyActionError,
  notifyActionSuccess,
  notifyBulkResult,
} from "~/lib/action-feedback";
import { getRequestSession } from "~/lib/auth/middleware.server";
import {
  bulkTargetsJson,
  isBulkActionResult,
  parseIdBulkTargets,
  runBulkAction,
} from "~/lib/bulk-action";
import { actionFailure } from "~/lib/errors";
import { formatDateTime } from "~/lib/format";
import type { BulkActionResult } from "~/lib/types";
import { useFetcherResult } from "~/lib/use-fetcher-result";
import { useRowSelection } from "~/lib/use-row-selection";
import {
  addSshKey,
  deleteSshKey,
  listSshKeysOrEmpty,
  type SshKeyView,
} from "~/ssh-keys/ssh-keys.server";
import {
  BulkActionBar,
  ConfirmBulkDeleteModal,
  ConfirmDeleteModal,
  ConsolePaper,
  PageHeader,
  ResourceTable,
  Table,
} from "~/ui";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "SSH Keys · kmc" }];
}

export async function loader(_args: Route.LoaderArgs) {
  const session = getRequestSession();
  const user = session?.user ?? null;
  const { keys, settingsCluster, error } = await listSshKeysOrEmpty(user);
  return {
    signedIn: Boolean(user),
    githubLogin: user?.githubLogin ?? null,
    keys,
    settingsCluster,
    listError: error ?? null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const session = getRequestSession();
  const user = session?.user;
  if (!user) {
    return { ok: false as const, error: "Sign in to manage SSH keys", intent: "auth" };
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "add") {
    const name = String(form.get("name") ?? "");
    const publicKey = String(form.get("publicKey") ?? "");
    try {
      await addSshKey(user, { name, publicKey });
      return { ok: true as const, intent };
    } catch (err) {
      return actionFailure("ssh-keys.add", err, { intent });
    }
  }

  if (intent === "delete") {
    const id = String(form.get("id") ?? "");
    try {
      await deleteSshKey(user, id);
      return { ok: true as const, intent };
    } catch (err) {
      return actionFailure("ssh-keys.delete", err, { intent, id });
    }
  }

  if (intent === "bulk-delete") {
    const { targets, error } = parseIdBulkTargets(form.get("targets"));
    if (error || !targets) {
      return {
        ok: false,
        error: error ?? "Missing targets",
        intent,
        summary: { total: 0, succeeded: 0, skipped: 0, failed: 0 },
        results: [],
      };
    }
    return runBulkAction(intent, targets, (t) => t.id, async (t) => {
      await deleteSshKey(user, t.id);
    });
  }

  return { ok: false as const, error: `Unknown intent: ${intent}`, intent };
}

type ActionResult =
  | { ok?: boolean; error?: string; intent?: string }
  | BulkActionResult;

export default function SshKeysPage({ loaderData }: Route.ComponentProps) {
  const { signedIn, keys, settingsCluster, listError } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const revalidator = useRevalidator();
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SshKeyView | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const form = useForm({
    initialValues: { name: "", publicKey: "" },
    validate: {
      name: (v) => (!v.trim() ? "Required" : null),
      publicKey: (v) => (!v.trim() ? "Required" : null),
    },
  });

  const visibleKeys = useMemo(() => keys.map((key) => key.id), [keys]);
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

  const selectedKeys = useMemo(
    () => keys.filter((key) => selected.has(key.id)),
    [keys, selected],
  );

  useFetcherResult(fetcher, (data) => {
    if (isBulkActionResult(data)) {
      if (data.error && data.results.length === 0) {
        notifyActionError("Bulk action failed", data.error, { intent: data.intent });
        return;
      }
      notifyBulkResult("deleted", data.summary, data.results);
      clear();
      setBulkDeleteOpen(false);
      revalidator.revalidate();
      return;
    }
    if (data.error) {
      notifyActionError("SSH keys", data.error, { intent: data.intent });
    } else if (data.ok) {
      if (data.intent === "add") {
        notifyActionSuccess("SSH key saved", "Available when creating VMs");
        form.reset();
        setAddOpen(false);
      } else if (data.intent === "delete") {
        notifyActionSuccess("SSH key deleted", "Removed from your library");
        setDeleteTarget(null);
      }
      revalidator.revalidate();
    }
  });

  const busy = fetcher.state !== "idle";

  const onAdd = form.onSubmit((values) => {
    fetcher.submit(
      {
        intent: "add",
        name: values.name,
        publicKey: values.publicKey,
      },
      { method: "post" },
    );
  });

  return (
    <Stack gap="md">
      <PageHeader
        title="SSH Keys"
        description="Saved public keys for VM cloud-init. Select one when creating a VM."
        actions={
          signedIn ? (
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={() => setAddOpen(true)}
            >
              Add key
            </Button>
          ) : null
        }
      />

      {!signedIn ? (
        <ConsolePaper>
          <Stack gap="sm">
            <Text size="sm">
              Sign in with GitHub to store SSH public keys. Keys are kept as a ConfigMap
              on the settings cluster and are available across devices.
            </Text>
            <Group>
              <Button component={Link} to="/login" leftSection={<IconKey size={16} />}>
                Sign in
              </Button>
            </Group>
          </Stack>
        </ConsolePaper>
      ) : (
        <>
          {listError ? (
            <Alert color="red" title="Could not load SSH keys">
              {listError}
            </Alert>
          ) : null}

          <ConsolePaper>
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
                headers={[
                  <Checkbox
                    key="select-all"
                    aria-label="Select all"
                    checked={allSelected}
                    indeterminate={someSelected}
                    disabled={busy || keys.length === 0}
                    onChange={() => toggleAllVisible()}
                  />,
                  "Name",
                  "Fingerprint",
                  "Created",
                  "",
                ]}
                isEmpty={keys.length === 0}
                emptyMessage="No SSH keys saved yet. Add a public key to select it when creating VMs."
              >
                {keys.map((key) => (
                  <Table.Tr
                    key={key.id}
                    bg={isSelected(key.id) ? "dark.7" : undefined}
                  >
                    <Table.Td w={40}>
                      <Checkbox
                        aria-label={`Select ${key.name}`}
                        checked={isSelected(key.id)}
                        disabled={busy}
                        onChange={() => toggle(key.id)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {key.name}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Code style={{ fontSize: 12 }}>{key.fingerprint}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {formatDateTime(key.createdAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td w={48}>
                      <Tooltip label="Delete">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={`Delete ${key.name}`}
                          onClick={() => setDeleteTarget(key)}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </ResourceTable>
            </Stack>
          </ConsolePaper>

          <Text size="xs" c="dimmed">
            Stored on settings cluster{" "}
            <Code style={{ fontSize: 11 }}>{settingsCluster}</Code> in namespace{" "}
            <Code style={{ fontSize: 11 }}>kmc-system</Code>
          </Text>
        </>
      )}

      <Modal
        opened={addOpen}
        onClose={() => {
          if (!busy) {
            setAddOpen(false);
            form.reset();
          }
        }}
        title="Add SSH public key"
        centered
        size="lg"
      >
        <form onSubmit={onAdd}>
          <Stack gap="md">
            <TextInput
              label="Name"
              description="Label for this key (e.g. laptop, yubikey)"
              placeholder="laptop"
              required
              data-autofocus
              {...form.getInputProps("name")}
            />
            <Textarea
              label="Public key"
              description="OpenSSH format — one line, starts with ssh-ed25519 or ssh-rsa"
              placeholder="ssh-ed25519 AAAA… comment"
              minRows={3}
              autosize
              required
              styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
              {...form.getInputProps("publicKey")}
            />
            <Group justify="flex-end">
              <Button
                variant="default"
                onClick={() => {
                  setAddOpen(false);
                  form.reset();
                }}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" loading={busy && fetcher.formData?.get("intent") === "add"}>
                Save key
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <ConfirmDeleteModal
        opened={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          fetcher.submit(
            { intent: "delete", id: deleteTarget.id },
            { method: "post" },
          );
        }}
        loading={busy && fetcher.formData?.get("intent") === "delete"}
        title="Delete SSH key"
        confirmLabel="Delete key"
        resourceName={deleteTarget?.name ?? null}
        identity={deleteTarget?.name}
        warning="VMs already created with this key are unaffected."
      />

      <ConfirmBulkDeleteModal
        opened={bulkDeleteOpen}
        count={selectedKeys.length}
        identities={selectedKeys.map((key) => key.name)}
        title={`Delete ${selectedKeys.length} SSH key${selectedKeys.length === 1 ? "" : "s"}`}
        confirmLabel={`Delete ${selectedKeys.length}`}
        warning="VMs already created with these keys are unaffected."
        loading={busy}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={() => {
          fetcher.submit(
            {
              intent: "bulk-delete",
              targets: bulkTargetsJson(
                selectedKeys.map((key) => ({ id: key.id })),
              ),
            },
            { method: "post" },
          );
        }}
      />
    </Stack>
  );
}
