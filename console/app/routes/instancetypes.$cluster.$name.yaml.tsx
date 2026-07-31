import { Code, Group, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import type { Route } from "./+types/instancetypes.$cluster.$name.yaml";
import { DetailSection, YamlPanel } from "~/ui";
import { getCustomObjectYaml } from "~/lib/k8s/yaml.server";
import type { loader as detailLoader } from "./instancetypes.$cluster.$name";

const LAYOUT_ID = "routes/instancetypes.$cluster.$name";

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, name } = params;
  if (!cluster || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  const yaml = await getCustomObjectYaml({
    cluster,
    group: "instancetype.kubevirt.io",
    version: "v1beta1",
    plural: "virtualmachineclusterinstancetypes",
    name,
  });

  return { yaml };
}

export default function InstanceTypeYamlTab({ loaderData }: Route.ComponentProps) {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { it } = data;
  const hasLabels = Object.keys(it.labels).length > 0;

  return (
    <Stack gap="md">
      {hasLabels && (
        <DetailSection title="Labels">
          <Stack gap={6}>
            {Object.entries(it.labels).map(([k, v]) => (
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
