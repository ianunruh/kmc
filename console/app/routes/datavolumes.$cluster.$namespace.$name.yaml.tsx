import { Code, Group, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import type { Route } from "./+types/datavolumes.$cluster.$namespace.$name.yaml";
import { DetailSection, YamlPanel } from "~/ui";
import { getCustomObjectYaml } from "~/lib/k8s/yaml.server";
import type { loader as detailLoader } from "./datavolumes.$cluster.$namespace.$name";
import { tracedLoader } from "~/lib/request-traces.server";

const LAYOUT_ID = "routes/datavolumes.$cluster.$namespace.$name";

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  const yaml = await getCustomObjectYaml({
    cluster,
    group: "cdi.kubevirt.io",
    version: "v1beta1",
    plural: "datavolumes",
    namespace,
    name,
  });

  return { yaml };
});

export default function DataVolumeYamlTab({ loaderData }: Route.ComponentProps) {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { dv } = data;
  const hasLabels = Object.keys(dv.labels).length > 0;

  return (
    <Stack gap="md">
      {hasLabels && (
        <DetailSection title="Labels">
          <Stack gap={6}>
            {Object.entries(dv.labels).map(([k, v]) => (
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
