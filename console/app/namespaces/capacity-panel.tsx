import { Badge, Group, Progress, SimpleGrid, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import type { NamespaceQuota, NamespaceQuotaResource } from "~/lib/types";
import { DetailSection } from "~/ui";
import { formatQuotaQuantity } from "./quantity";
import { capacityColor } from "./quota";

function formatPercent(percent: number | null): string {
  if (percent == null) return "";
  if (percent >= 10) return `${Math.round(percent)}%`;
  if (percent >= 1) return `${percent.toFixed(1)}%`;
  return `${percent.toFixed(2)}%`;
}

function CapacityRow({ row }: { row: NamespaceQuotaResource }) {
  const pct = row.percent;
  const barValue = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  const color = capacityColor(pct);
  const usedLabel = formatQuotaQuantity(row.used ?? "0", row.unitKind, "0");
  const hardLabel = formatQuotaQuantity(row.hard, row.unitKind);

  return (
    <div>
      <Group justify="space-between" align="baseline" mb={4} gap="xs" wrap="nowrap">
        <Text size="sm" fw={500}>
          {row.label}
        </Text>
        <Text
          size="sm"
          c="dimmed"
          style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}
        >
          {usedLabel}
          <Text span c="dimmed">
            {" "}
            / {hardLabel}
          </Text>
          {pct != null && (
            <Text span size="xs" c={color} ml={6}>
              {formatPercent(pct)}
            </Text>
          )}
        </Text>
      </Group>
      <Progress
        value={barValue}
        color={color}
        size="sm"
        radius="sm"
        aria-label={`${row.label}: ${usedLabel} of ${hardLabel}`}
      />
      <Text size="xs" c="dimmed" mt={4} ff="monospace">
        {row.name}
      </Text>
    </div>
  );
}

function QuotaBlock({
  quota,
  showName,
}: {
  quota: NamespaceQuota;
  showName: boolean;
}) {
  if (quota.resources.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        ResourceQuota has no hard limits.
      </Text>
    );
  }

  return (
    <Stack gap="md">
      {showName && (
        <Group gap="xs">
          <Text size="sm" fw={600} ff="monospace">
            {quota.name}
          </Text>
          {quota.managedByKmc ? (
            <Badge size="xs" variant="light" color="teal">
              kmc
            </Badge>
          ) : (
            <Badge size="xs" variant="light" color="gray">
              external
            </Badge>
          )}
        </Group>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg" verticalSpacing="md">
        {quota.resources.map((row) => (
          <CapacityRow key={row.name} row={row} />
        ))}
      </SimpleGrid>
    </Stack>
  );
}

export function NamespaceCapacityPanel({
  quotas,
  actions,
}: {
  quotas: NamespaceQuota[];
  actions?: ReactNode;
}) {
  if (quotas.length === 0) {
    return (
      <DetailSection title="Capacity" actions={actions}>
        <Text size="sm" c="dimmed">
          No ResourceQuota in this namespace. Set quotas to cap CPU, memory,
          storage, and VM count for the project.
        </Text>
      </DetailSection>
    );
  }

  const showNames = quotas.length > 1;

  return (
    <DetailSection title="Capacity" actions={actions}>
      <Stack gap="xl">
        {quotas.map((q) => (
          <QuotaBlock key={q.name} quota={q} showName={showNames} />
        ))}
      </Stack>
    </DetailSection>
  );
}
