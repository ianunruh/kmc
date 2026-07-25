import { Button, Code, SimpleGrid, Stack } from "@mantine/core";
import { IconAdjustments } from "@tabler/icons-react";
import { Link, useRouteLoaderData } from "react-router";
import { DetailField, DetailSection, ResourceLink } from "~/ui";
import {
  formatAge,
  formatDateTime,
  namespaceEditPath,
  namespacesListPath,
  vpcsListPath,
  vmsListPath,
} from "~/lib/format";
import { NamespaceCapacityPanel } from "~/namespaces/capacity-panel";
import type { loader as detailLoader } from "./namespaces.$cluster.$name";

const LAYOUT_ID = "routes/namespaces.$cluster.$name";

export default function NamespaceOverviewTab() {
  const data = useRouteLoaderData(LAYOUT_ID) as Awaited<
    ReturnType<typeof detailLoader>
  >;
  const { ns } = data;

return (
    <Stack gap="md">
      <DetailSection title="Overview">
        <SimpleGrid cols={2} spacing="sm">
          <DetailField
            label="Cluster"
            value={
              <ResourceLink to={namespacesListPath({ cluster: ns.cluster })} dimmed>
                {ns.cluster}
              </ResourceLink>
            }
          />
          <DetailField label="Name" value={ns.name} />
          <DetailField label="Phase" value={ns.phase} />
          <DetailField label="Age" value={formatAge(ns.age)} />
          <DetailField label="Created" value={formatDateTime(ns.age)} />
          <DetailField
            label="UID"
            value={ns.uid ? <Code>{ns.uid}</Code> : undefined}
          />
          <DetailField
            label="Virtual Machines"
            value={
              <ResourceLink
                to={vmsListPath({
                  cluster: ns.cluster,
                  namespace: ns.name,
                })}
              >
                View VMs ({ns.vmCount})
              </ResourceLink>
            }
          />
          <DetailField
            label="VPCs"
            value={
              <ResourceLink
                to={vpcsListPath({
                  cluster: ns.cluster,
                  namespace: ns.name,
                })}
              >
                View VPCs
              </ResourceLink>
            }
          />
        </SimpleGrid>
      </DetailSection>

      <NamespaceCapacityPanel
        quotas={ns.quotas}
        actions={
          <Button
            component={Link}
            to={namespaceEditPath(ns)}
            size="xs"
            variant="light"
            leftSection={<IconAdjustments size={14} />}
          >
            {ns.quota?.managedByKmc ? "Edit quotas" : "Set quotas"}
          </Button>
        }
      />
    </Stack>
  );
}
