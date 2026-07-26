import { Alert, Code, SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import {
  CopyableValue,
  DetailField,
  DetailSection,
  RevealableValue,
} from "~/ui";
import type { loader as detailLoader } from "./object-storage.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/object-storage.$cluster.$namespace.$name";

/** Path-style bucket URL: `https://s3.example.com/my-bucket`. */
function bucketPathUrl(
  endpoint: string | undefined,
  bucketName: string | undefined,
): string | undefined {
  if (!endpoint?.trim()) return undefined;
  const base = endpoint.trim().replace(/\/+$/, "");
  if (!bucketName?.trim()) return base;
  return `${base}/${bucketName.trim()}`;
}

export default function ObjectStorageAccessTab() {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { bucket, externalEndpoint } = data;
  const creds = bucket.credentials;
  const bucketName = creds?.bucketName || bucket.bucketName;

  if (!creds) {
    return (
      <Stack gap="md">
        <DetailSection title="S3 credentials">
          <Text size="sm" c="dimmed">
            Credentials are not loaded for this claim.
          </Text>
        </DetailSection>
      </Stack>
    );
  }

  if (creds.error && !creds.accessKeyId && !creds.bucketHost) {
    const externalBucketUrl = bucketPathUrl(externalEndpoint ?? undefined, bucketName);
    return (
      <Stack gap="md">
        {externalBucketUrl ? (
          <DetailSection title="Endpoint">
            <DetailField
              label="External endpoint"
              value={<CopyableValue value={externalBucketUrl} />}
            />
            <Text size="xs" c="dimmed" mt="sm">
              Public S3 API for this cluster. In-cluster endpoint is not
              available until the claim ConfigMap is ready.
            </Text>
          </DetailSection>
        ) : null}
        <DetailSection title="S3 credentials">
          <Alert color="yellow" variant="light" title="Credentials unavailable">
            {creds.error}
          </Alert>
          <Text size="xs" c="dimmed" mt="xs">
            ConfigMap / Secret: <Code>{creds.configMapName}</Code>
          </Text>
        </DetailSection>
      </Stack>
    );
  }

  const inClusterBase =
    creds.endpoint ||
    (creds.bucketHost ? `http://${creds.bucketHost}` : undefined);
  const externalBucketUrl = bucketPathUrl(
    externalEndpoint ?? undefined,
    bucketName,
  );
  const inClusterBucketUrl = bucketPathUrl(inClusterBase, bucketName);
  const cliEndpoint =
    externalEndpoint ||
    inClusterBase ||
    undefined;

  return (
    <Stack gap="md">
      <DetailSection title="Endpoint">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <DetailField
            label="External endpoint"
            value={
              externalBucketUrl ? (
                <CopyableValue value={externalBucketUrl} />
              ) : externalEndpoint ? (
                <CopyableValue value={externalEndpoint} />
              ) : (
                <Text size="sm" c="dimmed">
                  — (set objectStorageEndpoint in clusters.yaml)
                </Text>
              )
            }
          />
          <DetailField
            label="In-cluster endpoint"
            value={
              inClusterBucketUrl ? (
                <CopyableValue value={inClusterBucketUrl} />
              ) : undefined
            }
          />
          <DetailField
            label="Bucket name"
            value={
              bucketName ? <CopyableValue value={bucketName} /> : undefined
            }
          />
          <DetailField
            label="Region"
            value={
              creds.bucketRegion ? (
                <CopyableValue value={creds.bucketRegion} />
              ) : (
                <Text size="sm" c="dimmed">
                  — (often unused for Ceph RGW)
                </Text>
              )
            }
          />
        </SimpleGrid>
        <Text size="xs" c="dimmed" mt="sm">
          Path-style URLs including the bucket name. Prefer the external
          endpoint from outside the cluster; use the in-cluster URL for pods.
        </Text>
      </DetailSection>

      <DetailSection title="Access keys">
        {creds.error ? (
          <Alert color="yellow" variant="light" mb="sm">
            {creds.error}
          </Alert>
        ) : null}
        <SimpleGrid cols={1} spacing="sm">
          <DetailField
            label="Access key ID"
            value={
              creds.accessKeyId ? (
                <CopyableValue value={creds.accessKeyId} />
              ) : undefined
            }
          />
          <DetailField
            label="Secret access key"
            value={
              creds.secretAccessKey ? (
                <RevealableValue value={creds.secretAccessKey} />
              ) : undefined
            }
          />
          <Text size="xs" c="dimmed">
            From Secret <Code>{creds.secretName}</Code> · ConfigMap{" "}
            <Code>{creds.configMapName}</Code> (AWS_ACCESS_KEY_ID /
            AWS_SECRET_ACCESS_KEY)
          </Text>
        </SimpleGrid>
      </DetailSection>

      {cliEndpoint && creds.accessKeyId && bucketName ? (
        <>
          <DetailSection title="Example (AWS CLI)">
            <Code block style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
              {`export AWS_ACCESS_KEY_ID=${creds.accessKeyId}
export AWS_SECRET_ACCESS_KEY=***
aws --endpoint-url ${cliEndpoint} s3 ls s3://${bucketName}`}
            </Code>
            {externalEndpoint && creds.endpoint ? (
              <Text size="xs" c="dimmed" mt="xs">
                Example uses the external endpoint. In-cluster:{" "}
                <Code>{creds.endpoint}</Code>
              </Text>
            ) : null}
          </DetailSection>

          <DetailSection title="Example (MinIO Client)">
            <Code block style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
              {`mc alias set kmc ${cliEndpoint} ${creds.accessKeyId} ***
mc ls kmc/${bucketName}
mc cp ./file.txt kmc/${bucketName}/`}
            </Code>
            {externalEndpoint && creds.endpoint ? (
              <Text size="xs" c="dimmed" mt="xs">
                Alias uses the external endpoint. For in-cluster pods:{" "}
                <Code>{`mc alias set kmc ${creds.endpoint} …`}</Code>
              </Text>
            ) : null}
          </DetailSection>
        </>
      ) : null}
    </Stack>
  );
}
