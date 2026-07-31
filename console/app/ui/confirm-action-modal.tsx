import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

export function ConfirmActionModal({
  opened,
  onClose,
  onConfirm,
  loading,
  title,
  confirmLabel = "Confirm",
  confirmColor = "blue",
  message,
}: {
  opened: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
  title: string;
  confirmLabel?: string;
  confirmColor?: string;
  message: ReactNode;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title={title} centered>
      <Stack gap="md">
        <Text size="sm">{message}</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button color={confirmColor} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
