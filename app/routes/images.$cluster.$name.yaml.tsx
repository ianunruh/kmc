import { Code, Group, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import type { Route } from "./+types/images.$cluster.$name.yaml";
import { DetailSection, YamlPanel } from "~/ui";
import { getImageYaml } from "~/images/images.server";
import type { loader as detailLoader } from "./images.$cluster.$name";

const LAYOUT_ID = "routes/images.$cluster.$name";

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, name } = params;
  if (!cluster || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  const yaml = await getImageYaml(cluster, name);
  return { yaml };
}

export default function ImageYamlTab({ loaderData }: Route.ComponentProps) {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<ReturnType<typeof detailLoader>>;
  const { image } = data;
  const hasLabels = Object.keys(image.labels).length > 0;

  return (
    <Stack gap="md">
      {hasLabels && (
        <DetailSection title="Labels">
          <Stack gap={6}>
            {Object.entries(image.labels).map(([k, v]) => (
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
