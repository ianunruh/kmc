import { Code, Group, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import type { Route } from "./+types/databases.$cluster.$namespace.$name.yaml";
import { DetailSection, YamlPanel } from "~/ui";
import {
  CNPG_CLUSTER_PLURAL,
  CNPG_GROUP,
  CNPG_VERSION,
} from "~/lib/k8s/constants";
import { getCustomObjectYaml } from "~/lib/k8s/yaml.server";
import type { loader as detailLoader } from "./databases.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/databases.$cluster.$namespace.$name";

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  const yaml = await getCustomObjectYaml({
    cluster,
    group: CNPG_GROUP,
    version: CNPG_VERSION,
    plural: CNPG_CLUSTER_PLURAL,
    namespace,
    name,
  });

  return { yaml };
}

export default function DatabaseYamlTab({ loaderData }: Route.ComponentProps) {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { db } = data;
  const hasLabels = Object.keys(db.labels).length > 0;

  return (
    <Stack gap="md">
      {hasLabels && (
        <DetailSection title="Labels">
          <Stack gap={6}>
            {Object.entries(db.labels).map(([k, v]) => (
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
