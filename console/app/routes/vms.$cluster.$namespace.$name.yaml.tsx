import { Code, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import type { Route } from "./+types/vms.$cluster.$namespace.$name.yaml";
import { DetailSection, YamlPanel } from "~/ui";
import { getCustomObjectYaml } from "~/lib/k8s/yaml.server";
import { interestingAnnotations, useVmDetail } from "~/vms/vm-detail-shared";
import { tracedLoader } from "~/lib/request-traces.server";

export const loader = tracedLoader(async ({ params }: Route.LoaderArgs) => {
  const { cluster, namespace, name } = params;
  if (!cluster || !namespace || !name) {
    throw new Response("Missing path params", { status: 400 });
  }

  const yaml = await getCustomObjectYaml({
    cluster,
    group: "kubevirt.io",
    version: "v1",
    plural: "virtualmachines",
    namespace,
    name,
  });

  return { yaml };
});

export default function VmYamlTab({ loaderData }: Route.ComponentProps) {
  const { vm } = useVmDetail();
  const annotations = interestingAnnotations(vm.annotations);
  const hasLabels = Object.keys(vm.labels).length > 0;
  const hasAnnotations = annotations.length > 0;

  return (
    <Stack gap="md">
      {(hasLabels || hasAnnotations) && (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          {hasLabels && (
            <DetailSection title="Labels">
              <Stack gap={6}>
                {Object.entries(vm.labels).map(([k, v]) => (
                  <Group key={k} gap="xs" wrap="nowrap" align="flex-start">
                    <Code>{k}</Code>
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
                {annotations.map(([k, v]) => (
                  <div key={k}>
                    <Code>{k}</Code>
                    <Text size="sm" c="dimmed" mt={2} style={{ wordBreak: "break-all" }}>
                      {v}
                    </Text>
                  </div>
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
