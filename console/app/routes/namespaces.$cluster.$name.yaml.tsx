import { Code, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { useRouteLoaderData } from "react-router";
import type { Route } from "./+types/namespaces.$cluster.$name.yaml";
import { DetailSection, YamlPanel } from "~/ui";
import { getNamespaceYaml } from "~/namespaces/namespaces.server";
import { VM_ALLOWED_LABEL } from "~/lib/k8s/constants";
import type { loader as detailLoader } from "./namespaces.$cluster.$name";
import { tracedLoader } from "~/lib/request-traces.server";

const LAYOUT_ID = "routes/namespaces.$cluster.$name";

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, name } = params;
  if (!cluster || !name) {
    throw new Response("Missing path params", { status: 400 });
  }
  const yaml = await getNamespaceYaml(cluster, name);
  return { yaml };
});

export default function NamespaceYamlTab({ loaderData }: Route.ComponentProps) {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { ns } = data;
  const hasLabels = Object.keys(ns.labels).length > 0;
  const hasAnnotations = Object.keys(ns.annotations).length > 0;

  return (
    <Stack gap="md">
      {(hasLabels || hasAnnotations) && (
        <SimpleGrid cols={{ base: 1, md: hasAnnotations ? 2 : 1 }} spacing="md">
          {hasLabels && (
            <DetailSection title="Labels">
              <Stack gap={6}>
                {Object.entries(ns.labels).map(([k, v]) => (
                  <Group key={k} gap="xs" wrap="nowrap" align="flex-start">
                    <Code
                      style={{
                        color:
                          k === VM_ALLOWED_LABEL
                            ? "var(--mantine-color-teal-4)"
                            : undefined,
                      }}
                    >
                      {k}
                    </Code>
                    <Text size="sm" c="dimmed">
                      {v}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </DetailSection>
          )}
          {hasAnnotations && (
            <DetailSection title="Annotations">
              <Stack gap={6}>
                {Object.entries(ns.annotations).map(([k, v]) => (
                  <Group key={k} gap="xs" wrap="nowrap" align="flex-start">
                    <Code>{k}</Code>
                    <Text size="sm" c="dimmed" style={{ wordBreak: "break-all" }}>
                      {v}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </DetailSection>
          )}
        </SimpleGrid>
      )}
      <YamlPanel yaml={loaderData.yaml} />
    </Stack>
  );
}
