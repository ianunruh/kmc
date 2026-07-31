import {
  ActionIcon,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { BackendPortProtocol } from "~/lib/types";

export type PortRow = {
  name: string;
  port: number;
  targetPort: number;
  protocol: BackendPortProtocol;
};

export function emptyPortRow(defaults?: Partial<PortRow>): PortRow {
  return {
    name: defaults?.name ?? "",
    port: defaults?.port ?? 80,
    targetPort: defaults?.targetPort ?? 80,
    protocol: defaults?.protocol ?? "TCP",
  };
}

function ColHeader({
  children,
  flex,
  w,
}: {
  children: ReactNode;
  flex?: number;
  w?: number | string;
}) {
  return (
    <Text
      size="sm"
      fw={500}
      style={{ flex, width: w, minWidth: w }}
      component="div"
    >
      {children}
    </Text>
  );
}

/** Editable multi-port list for Load Balancer create/edit. */
export function BackendPortsFields({
  ports,
  onChange,
  minRows = 1,
}: {
  ports: PortRow[];
  onChange: (ports: PortRow[]) => void;
  minRows?: number;
}) {
  const update = (index: number, patch: Partial<PortRow>) => {
    onChange(ports.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        Service port is the VIP listen port; target is the guest / pod port.
        Name is optional.
      </Text>

      <Group wrap="nowrap" gap="xs" px={0}>
        <ColHeader flex={1}>Service port</ColHeader>
        <ColHeader flex={1}>Target port</ColHeader>
        <ColHeader w={100}>Protocol</ColHeader>
        <ColHeader flex={1}>Name</ColHeader>
        {/* Match trash ActionIcon width so columns stay aligned */}
        <div style={{ width: 28, flexShrink: 0 }} />
      </Group>

      {ports.map((row, index) => (
        <Group key={index} align="center" wrap="nowrap" gap="xs">
          <NumberInput
            aria-label={`Service port ${index + 1}`}
            min={1}
            max={65535}
            required
            value={row.port}
            onChange={(v) =>
              update(index, { port: typeof v === "number" ? v : Number(v) || 0 })
            }
            style={{ flex: 1 }}
          />
          <NumberInput
            aria-label={`Target port ${index + 1}`}
            min={1}
            max={65535}
            required
            value={row.targetPort}
            onChange={(v) =>
              update(index, {
                targetPort: typeof v === "number" ? v : Number(v) || 0,
              })
            }
            style={{ flex: 1 }}
          />
          <Select
            aria-label={`Protocol ${index + 1}`}
            data={["TCP", "UDP"]}
            value={row.protocol}
            onChange={(v) =>
              update(index, {
                protocol: (v as BackendPortProtocol) ?? "TCP",
              })
            }
            w={100}
          />
          <TextInput
            aria-label={`Port name ${index + 1}`}
            placeholder="http"
            value={row.name}
            onChange={(e) => update(index, { name: e.currentTarget.value })}
            style={{ flex: 1 }}
          />
          <ActionIcon
            variant="subtle"
            color="red"
            disabled={ports.length <= minRows}
            onClick={() => onChange(ports.filter((_, i) => i !== index))}
            aria-label="Remove port"
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}

      <ActionIcon
        variant="light"
        color="teal"
        onClick={() => onChange([...ports, emptyPortRow()])}
        aria-label="Add port"
        title="Add port"
      >
        <IconPlus size={16} />
      </ActionIcon>
    </Stack>
  );
}
