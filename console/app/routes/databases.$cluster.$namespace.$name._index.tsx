import { Badge, Code, SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import {
  ClampedText,
  DetailField,
  DetailSection,
  ResourceLink,
  ResourceTable,
  StatusBadge,
  Table,
} from "~/ui";
import {
  databasesListPath,
  formatAge,
  formatDateTime,
} from "~/lib/format";
import { DatabaseMetricsPanel } from "~/databases/db-metrics-panel";
import type { loader as detailLoader } from "./databases.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/databases.$cluster.$namespace.$name";

export default function DatabaseOverviewTab() {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { db, prometheusConfigured } = data;

  const resources =
    db.cpuRequest || db.memoryRequest || db.cpuLimit || db.memoryLimit
      ? [
          db.cpuRequest || db.memoryRequest
            ? `req ${db.cpuRequest ?? "—"} / ${db.memoryRequest ?? "—"}`
            : null,
          db.cpuLimit || db.memoryLimit
            ? `lim ${db.cpuLimit ?? "—"} / ${db.memoryLimit ?? "—"}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : undefined;

  return (
    <Stack gap="md">
      {prometheusConfigured && (
        <DatabaseMetricsPanel
          cluster={db.cluster}
          namespace={db.namespace}
          name={db.name}
        />
      )}

      <DetailSection title="Overview">
        <SimpleGrid cols={{ base: 2, md: 3 }} spacing="sm">
          <DetailField
            label="Status"
            value={
              <ResourceLink
                to={databasesListPath({
                  cluster: db.cluster,
                  status: db.status,
                })}
                underline="never"
              >
                <StatusBadge status={db.status} />
              </ResourceLink>
            }
          />
          <DetailField label="Phase" value={db.phase} />
          <DetailField label="Age" value={formatAge(db.age)} />
          <DetailField label="Created" value={formatDateTime(db.age)} />
          <DetailField
            label="Cluster"
            value={
              <ResourceLink
                to={databasesListPath({ cluster: db.cluster })}
                dimmed
              >
                {db.cluster}
              </ResourceLink>
            }
          />
          <DetailField
            label="Namespace"
            value={
              <ResourceLink
                to={databasesListPath({
                  cluster: db.cluster,
                  namespace: db.namespace,
                })}
                dimmed
              >
                {db.namespace}
              </ResourceLink>
            }
          />
          <DetailField
            label="Instances"
            value={`${db.readyInstances} ready / ${db.instances} desired`}
          />
          <DetailField label="Primary" value={db.currentPrimary} />
          <DetailField label="Target primary" value={db.targetPrimary} />
          <DetailField label="Postgres" value={db.postgresVersion} />
          <DetailField
            label="Image"
            value={
              db.imageName ? (
                <Code style={{ fontSize: 12, wordBreak: "break-all" }}>
                  {db.imageName}
                </Code>
              ) : undefined
            }
          />
          <DetailField label="Storage" value={db.storageSize} />
          <DetailField label="Storage class" value={db.storageClass} />
          <DetailField label="Resources" value={resources} />
          <DetailField
            label="Superuser access"
            value={
              db.enableSuperuserAccess == null
                ? undefined
                : db.enableSuperuserAccess
                  ? "enabled"
                  : "disabled"
            }
          />
          <DetailField label="Database" value={db.databaseName} />
          <DetailField label="Owner" value={db.owner} />
          <DetailField
            label="Ownership"
            value={db.managedByKmc ? "kmc" : "external"}
          />
          <DetailField label="Size preset" value={db.sizePreset} />
          <DetailField
            label="UID"
            value={db.uid ? <Code>{db.uid}</Code> : undefined}
          />
        </SimpleGrid>
      </DetailSection>

      <DetailSection title="Instances">
        <ResourceTable
          isEmpty={!db.instanceNames || db.instanceNames.length === 0}
          emptyMessage="No instance names reported yet"
          headers={["Pod", "Role", "Health"]}
        >
          {(db.instanceNames ?? []).map((pod) => {
            const isPrimary = pod === db.currentPrimary;
            const healthy = db.healthyInstances?.includes(pod) ?? false;
            return (
              <Table.Tr key={pod}>
                <Table.Td>
                  <Code>{pod}</Code>
                </Table.Td>
                <Table.Td>
                  {isPrimary ? (
                    <Badge size="sm" variant="light" color="teal">
                      primary
                    </Badge>
                  ) : (
                    <Badge size="sm" variant="light" color="gray">
                      replica
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  <Badge
                    size="sm"
                    variant="light"
                    color={healthy ? "teal" : "orange"}
                  >
                    {healthy ? "healthy" : "unknown"}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </ResourceTable>
      </DetailSection>

      <DetailSection title="Conditions">
        <ResourceTable
          isEmpty={db.conditions.length === 0}
          emptyMessage="No conditions"
          headers={["Type", "Status", "Reason", "Message", "Last transition"]}
        >
          {db.conditions.map((c) => (
            <Table.Tr key={c.type}>
              <Table.Td>{c.type}</Table.Td>
              <Table.Td>
                <Badge
                  size="sm"
                  variant="light"
                  color={
                    c.status === "True"
                      ? "teal"
                      : c.status === "False"
                        ? "gray"
                        : "yellow"
                  }
                >
                  {c.status}
                </Badge>
              </Table.Td>
              <Table.Td>{c.reason ?? "—"}</Table.Td>
              <Table.Td>
                <ClampedText size="sm" c="dimmed" maw={420} lineClamp={3}>
                  {c.message ?? "—"}
                </ClampedText>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {formatDateTime(c.lastTransitionTime)}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </ResourceTable>
      </DetailSection>
    </Stack>
  );
}
