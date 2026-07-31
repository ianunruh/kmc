import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useState, type ReactNode } from "react";

export function ConfirmDeleteModal({
  opened,
  onClose,
  onConfirm,
  loading,
  title = "Delete resource",
  confirmLabel = "Delete",
  resourceName,
  identity,
  warning,
  extra,
}: {
  opened: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
  title?: string;
  confirmLabel?: string;
  /** Exact string the user must type to enable delete. */
  resourceName: string | null;
  /** Full identity shown in the body, e.g. cluster/ns/name. */
  identity?: string | null;
  warning?: string;
  /** Optional content below the warning (e.g. retain-disks radios). */
  extra?: ReactNode;
}) {
  const [confirmName, setConfirmName] = useState("");
  const matches = resourceName != null && confirmName === resourceName;

  return (
    <Modal
      opened={opened}
      onClose={() => {
        setConfirmName("");
        onClose();
      }}
      title={title}
      centered
    >
      {resourceName && (
        <Stack gap="md">
          <Text size="sm">
            This will permanently delete{" "}
            <Text span fw={700}>
              {identity ?? resourceName}
            </Text>
            .{warning ? ` ${warning}` : null}
          </Text>
          {extra}
          <TextInput
            label={`Type ${resourceName} to confirm`}
            value={confirmName}
            onChange={(e) => setConfirmName(e.currentTarget.value)}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setConfirmName("");
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button
              color="red"
              disabled={!matches}
              loading={loading}
              onClick={() => {
                onConfirm();
                setConfirmName("");
              }}
            >
              {confirmLabel}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
