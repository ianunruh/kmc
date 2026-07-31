import { Button, Group, Modal, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import { useState, type ReactNode } from "react";

const CONFIRM_PHRASE = "delete";

/**
 * Multi-resource delete confirmation. User types "delete" (not each name).
 * Use for bulk actions; single-resource deletes keep ConfirmDeleteModal.
 */
export function ConfirmBulkDeleteModal({
  opened,
  onClose,
  onConfirm,
  loading,
  title,
  confirmLabel = "Delete",
  count,
  identities,
  warning,
  extra,
}: {
  opened: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
  title: string;
  confirmLabel?: string;
  count: number;
  /** Full identities shown in the body, e.g. cluster/ns/name. */
  identities: string[];
  warning?: string;
  /** Optional content below the list (e.g. retain-disks radios). */
  extra?: ReactNode;
}) {
  const [confirmText, setConfirmText] = useState("");
  const matches = confirmText === CONFIRM_PHRASE;

  const previewLimit = 12;
  const shown = identities.slice(0, previewLimit);
  const remaining = identities.length - shown.length;

  function handleClose() {
    setConfirmText("");
    onClose();
  }

  return (
    <Modal opened={opened} onClose={handleClose} title={title} centered size="md">
      <Stack gap="md">
        <Text size="sm">
          This will permanently delete{" "}
          <Text span fw={700}>
            {count} resource{count === 1 ? "" : "s"}
          </Text>
          .{warning ? ` ${warning}` : null}
        </Text>

        {identities.length > 0 && (
          <ScrollArea.Autosize mah={160} type="auto" offsetScrollbars>
            <Stack gap={4}>
              {shown.map((id) => (
                <Text key={id} size="xs" ff="monospace" c="dimmed">
                  {id}
                </Text>
              ))}
              {remaining > 0 && (
                <Text size="xs" c="dimmed">
                  …and {remaining} more
                </Text>
              )}
            </Stack>
          </ScrollArea.Autosize>
        )}

        {extra}

        <TextInput
          label={`Type ${CONFIRM_PHRASE} to confirm`}
          value={confirmText}
          onChange={(e) => setConfirmText(e.currentTarget.value)}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={handleClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            color="red"
            disabled={!matches}
            loading={loading}
            onClick={() => {
              onConfirm();
              setConfirmText("");
            }}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
