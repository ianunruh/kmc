import { Code, SimpleGrid, Stack } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import {
  CopyableValue,
  DetailField,
  DetailSection,
  ResourceLink,
  StatusBadge,
} from "~/ui";
import {
  formatAge,
  formatDateTime,
  objectStorageListPath,
} from "~/lib/format";
import type { loader as detailLoader } from "./object-storage.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/object-storage.$cluster.$namespace.$name";

export default function ObjectStorageOverviewTab() {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { bucket, externalEndpoint } = data;

  return (
    <Stack gap="md">
      <DetailSection title="Overview">
        <SimpleGrid cols={{ base: 2, md: 3 }} spacing="sm">
          <DetailField
            label="Status"
            value={
              <ResourceLink
                to={objectStorageListPath({
                  cluster: bucket.cluster,
                  status: bucket.status,
                })}
                underline="never"
              >
                <StatusBadge status={bucket.status} />
              </ResourceLink>
            }
          />
          <DetailField label="Phase" value={bucket.phase} />
          <DetailField label="Age" value={formatAge(bucket.age)} />
          <DetailField label="Created" value={formatDateTime(bucket.age)} />
          <DetailField
            label="Cluster"
            value={
              <ResourceLink
                to={objectStorageListPath({ cluster: bucket.cluster })}
                dimmed
              >
                {bucket.cluster}
              </ResourceLink>
            }
          />
          <DetailField
            label="Namespace"
            value={
              <ResourceLink
                to={objectStorageListPath({
                  cluster: bucket.cluster,
                  namespace: bucket.namespace,
                })}
                dimmed
              >
                {bucket.namespace}
              </ResourceLink>
            }
          />
          <DetailField
            label="Bucket name"
            value={
              bucket.bucketName ? (
                <Code style={{ fontSize: 12 }}>{bucket.bucketName}</Code>
              ) : undefined
            }
          />
          <DetailField
            label="External endpoint"
            value={
              externalEndpoint ? (
                <CopyableValue value={externalEndpoint} />
              ) : undefined
            }
          />
          <DetailField
            label="Requested bucket"
            value={
              bucket.requestedBucketName ? (
                <Code style={{ fontSize: 12 }}>
                  {bucket.requestedBucketName}
                </Code>
              ) : undefined
            }
          />
          <DetailField
            label="Generate prefix"
            value={
              bucket.generateBucketName ? (
                <Code style={{ fontSize: 12 }}>
                  {bucket.generateBucketName}
                </Code>
              ) : undefined
            }
          />
          <DetailField label="Storage class" value={bucket.storageClass} />
          <DetailField
            label="ObjectBucket"
            value={
              bucket.objectBucketName ? (
                <Code style={{ fontSize: 12 }}>{bucket.objectBucketName}</Code>
              ) : undefined
            }
          />
          <DetailField
            label="Ownership"
            value={bucket.managedByKmc ? "kmc" : "external"}
          />
          <DetailField
            label="UID"
            value={bucket.uid ? <Code>{bucket.uid}</Code> : undefined}
          />
        </SimpleGrid>
      </DetailSection>
    </Stack>
  );
}
