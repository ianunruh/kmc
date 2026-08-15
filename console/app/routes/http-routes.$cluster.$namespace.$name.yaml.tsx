import { SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import type { Route } from "./+types/http-routes.$cluster.$namespace.$name.yaml";
import { DetailSection, YamlPanel } from "~/ui";
import { getHttpRouteYaml } from "~/httproutes/httproutes.server";
import type { loader as detailLoader } from "./http-routes.$cluster.$namespace.$name";

const LAYOUT_ID = "routes/http-routes.$cluster.$namespace.$name";

export async function loader({ params }: Route.LoaderArgs) {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const yaml = await getHttpRouteYaml(cluster, namespace, name);
  return { yaml };
}

export default function HttpRouteYamlTab({ loaderData }: Route.ComponentProps) {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { route } = data;
  const hasLabels = Object.keys(route.labels).length > 0;
  const hasAnnotations = Object.keys(route.annotations).length > 0;

  return (
    <Stack gap="md">
      {(hasLabels || hasAnnotations) && (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          <DetailSection title="Labels">
            {!hasLabels ? (
              <Text size="sm" c="dimmed">
                None
              </Text>
            ) : (
              <Stack gap={4}>
                {Object.entries(route.labels)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => (
                    <Text key={k} size="sm" ff="monospace">
                      {k}={v}
                    </Text>
                  ))}
              </Stack>
            )}
          </DetailSection>
          <DetailSection title="Annotations">
            {!hasAnnotations ? (
              <Text size="sm" c="dimmed">
                None
              </Text>
            ) : (
              <Stack gap={4}>
                {Object.entries(route.annotations)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => (
                    <Text
                      key={k}
                      size="sm"
                      ff="monospace"
                      style={{ wordBreak: "break-all" }}
                    >
                      {k}={v}
                    </Text>
                  ))}
              </Stack>
            )}
          </DetailSection>
        </SimpleGrid>
      )}
      <YamlPanel yaml={loaderData.yaml} />
    </Stack>
  );
}
