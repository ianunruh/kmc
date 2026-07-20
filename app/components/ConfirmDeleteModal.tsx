import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import type { VmSummary } from "~/lib/types";

export function ConfirmDeleteModal({
  vm,
  opened,
  onClose,
  onConfirm,
  loading,
}: {
  vm: VmSummary | null;
  opened: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
}) {
  const [confirmName, setConfirmName] = useState("");

  const matches = vm != null && confirmName === vm.name;

  return (
    <Modal
      opened={opened}
      onClose={() => {
        setConfirmName("");
        onClose();
      }}
      title="Delete virtual machine"
      centered
    >
      {vm && (
        <Stack gap="md">
          <Text size="sm">
            This will permanently delete{" "}
            <Text span fw={700}>
              {vm.cluster}/{vm.namespace}/{vm.name}
            </Text>
            . Owned disks (DataVolumes) may also be removed.
          </Text>
          <TextInput
            label={`Type ${vm.name} to confirm`}
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
              Delete VM
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
