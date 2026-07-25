import { SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import { DetailField, DetailSection, ResourceLink } from "~/ui";
import { StatusBadge } from "~/ui/status-badge";
import { formatAge, formatDateTime, imageEditPath, imagesListPath } from "~/lib/format";
import type { loader as detailLoader } from "./images.$cluster.$name";

const LAYOUT_ID = "routes/images.$cluster.$name";

export default function ImageOverviewTab() {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<ReturnType<typeof detailLoader>>;
  const { image } = data;
  const sizeLabel = image.capacity ?? image.size ?? "—";

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <DetailSection title="Overview">
          <SimpleGrid cols={2} spacing="sm">
            <DetailField
              label="Phase"
              value={
                <ResourceLink
                  to={imagesListPath({
                    cluster: image.cluster,
                    phase: image.phase,
                  })}
                  underline="never"
                >
                  <StatusBadge status={image.phase} />
                </ResourceLink>
              }
            />
            <DetailField label="Progress" value={image.progress} />
            <DetailField label="Ready" value={image.ready ? "Yes" : "No"} />
            <DetailField label="Age" value={formatAge(image.age)} />
            <DetailField label="Created" value={formatDateTime(image.age)} />
            <DetailField
              label="Cluster"
              value={
                <ResourceLink to={imagesListPath({ cluster: image.cluster })} dimmed>
                  {image.cluster}
                </ResourceLink>
              }
            />
            <DetailField label="Namespace" value={image.namespace} />
            <DetailField label="Size" value={sizeLabel} />
            <DetailField label="Storage class" value={image.storageClass} />
            <DetailField label="Volume mode" value={image.volumeMode} />
            <DetailField label="Access modes" value={image.accessModes?.join(", ")} />
            <DetailField label="Claim" value={image.claimName} />
            <DetailField label="DataVolume" value={image.hasDataVolume ? "Yes" : "No"} />
            <DetailField label="PVC" value={image.hasPvc ? "Yes" : "No"} />
            <DetailField
              label="Preference"
              value={
                image.preference ? (
                  <ResourceLink to={imageEditPath(image)}>
                    {image.preference}
                  </ResourceLink>
                ) : (
                  <ResourceLink to={imageEditPath(image)} dimmed>
                    Not set · edit
                  </ResourceLink>
                )
              }
            />
          </SimpleGrid>
        </DetailSection>

        <DetailSection title="Source">
          <SimpleGrid cols={1} spacing="sm">
            <DetailField label="Kind" value={image.sourceKind ?? "—"} />
            <DetailField
              label="Detail"
              value={
                image.sourceDetail ? (
                  <Text size="sm" style={{ wordBreak: "break-all" }}>
                    {image.sourceDetail}
                  </Text>
                ) : (
                  "—"
                )
              }
            />
          </SimpleGrid>
        </DetailSection>
      </SimpleGrid>
    </Stack>
  );
}
