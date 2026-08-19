import { Code, Group, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import type { Route } from "./+types/object-storage.$cluster.$namespace.$name.yaml";
import { DetailSection, YamlPanel } from "~/ui";
import {
  OBC_CLAIM_PLURAL,
  OBC_GROUP,
  OBC_VERSION,
} from "~/lib/k8s/constants";
import { getCustomObjectYaml } from "~/lib/k8s/yaml.server";
import type { loader as detailLoader } from "./object-storage.$cluster.$namespace.$name";
import { tracedLoader } from "~/lib/request-traces.server";

const LAYOUT_ID = "routes/object-storage.$cluster.$namespace.$name";

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  const yaml = await getCustomObjectYaml({
    cluster,
    group: OBC_GROUP,
    version: OBC_VERSION,
    plural: OBC_CLAIM_PLURAL,
    namespace,
    name,
  });

  return { yaml };
});

export default function ObjectStorageYamlTab({
  loaderData,
}: Route.ComponentProps) {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { bucket } = data;
  const hasLabels = Object.keys(bucket.labels).length > 0;

  return (
    <Stack gap="md">
      {hasLabels && (
        <DetailSection title="Labels">
          <Stack gap={6}>
            {Object.entries(bucket.labels).map(([k, v]) => (
              <Group key={k} gap="xs">
                <Code>{k}</Code>
                <Text size="sm" c="dimmed">
                  {v}
                </Text>
              </Group>
            ))}
          </Stack>
        </DetailSection>
      )}
      <YamlPanel yaml={loaderData.yaml} />
    </Stack>
  );
}
