import { Code, SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import { DetailField, DetailSection, ResourceLink } from "~/ui";
import {
  formatAge,
  formatDateTime,
  instanceTypesListPath,
  vmsListPath,
} from "~/lib/format";
import { instanceTypeClassLabel } from "~/instancetypes/options";
import type { loader as detailLoader } from "./instancetypes.$cluster.$name";

const LAYOUT_ID = "routes/instancetypes.$cluster.$name";

export default function InstanceTypeOverviewTab() {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { it } = data;

  return (
    <DetailSection title="Overview">
      <SimpleGrid cols={2} spacing="sm">
        <DetailField
          label="Cluster"
          value={
            <ResourceLink to={instanceTypesListPath({ cluster: it.cluster })} dimmed>
              {it.cluster}
            </ResourceLink>
          }
        />
        <DetailField label="Name" value={it.name} />
        <DetailField
          label="Class"
          value={
            it.class ? (
              <Stack gap={2}>
                <Text size="sm">{instanceTypeClassLabel(it.class)}</Text>
                <Text size="xs" c="dimmed">
                  {it.class}
                </Text>
              </Stack>
            ) : (
              "—"
            )
          }
        />
        <DetailField label="Size" value={it.size || "—"} />
        <DetailField label="CPU" value={it.cpu ? `${it.cpu} cores` : "—"} />
        <DetailField label="Memory" value={it.memory || "—"} />
        <DetailField label="Vendor" value={it.vendor || "—"} />
        <DetailField
          label="common-instancetypes"
          value={it.commonVersion || (it.builtin ? "yes" : "—")}
        />
        <DetailField label="Age" value={formatAge(it.age)} />
        <DetailField label="Created" value={formatDateTime(it.age)} />
        <DetailField
          label="VMs using type"
          value={
            <ResourceLink
              to={vmsListPath({
                cluster: it.cluster,
                instancetype: it.name,
              })}
            >
              View VMs ({it.cluster})
            </ResourceLink>
          }
        />
        <DetailField label="UID" value={it.uid ? <Code>{it.uid}</Code> : undefined} />
      </SimpleGrid>
    </DetailSection>
  );
}
