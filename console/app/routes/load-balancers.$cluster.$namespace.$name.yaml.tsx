import { SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import type { Route } from "./+types/load-balancers.$cluster.$namespace.$name.yaml";
import { DetailSection, YamlPanel } from "~/ui";
import { getBackendYaml } from "~/backends/backends.server";
import type { loader as detailLoader } from "./load-balancers.$cluster.$namespace.$name";
import { tracedLoader } from "~/lib/request-traces.server";

const LAYOUT_ID = "routes/load-balancers.$cluster.$namespace.$name";

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const yaml = await getBackendYaml(cluster, namespace, name);
  return { yaml };
});

export default function LoadBalancerYamlTab({
  loaderData,
}: Route.ComponentProps) {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { lb } = data;
  const hasLabels = Object.keys(lb.labels).length > 0;
  const hasAnnotations = Object.keys(lb.annotations).length > 0;

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
                {Object.entries(lb.labels)
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
                {Object.entries(lb.annotations)
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
