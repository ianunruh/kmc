import { Badge, Group, Modal, Table, Text, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useMemo } from "react";
import { useMatches } from "react-router";
import { tracesFromMatches, type MatchedRequestTrace } from "~/lib/request-traces";

function formatRouteId(routeId: string): string {
  return routeId.replace(/^routes\//, "");
}

function elapsedColor(ms: number): string {
  if (ms >= 500) return "red";
  if (ms >= 200) return "yellow";
  return "gray";
}

export function RequestTracesFooter() {
  const matches = useMatches();
  const [opened, { open, close }] = useDisclosure(false);

  const traces = useMemo(() => {
    const collected = tracesFromMatches(matches);
    return [...collected].sort((a, b) => b.elapsedMs - a.elapsedMs);
  }, [matches]);

  if (traces.length === 0) {
    return null;
  }

  const maxElapsed = traces[0]?.elapsedMs ?? 0;

  return (
    <>
      <Group h="100%" w="100%" px="md" justify="flex-end" align="center" wrap="nowrap">
        <UnstyledButton onClick={open}>
          <Text size="xs" lh={1} c="dimmed">
            {traces.length} request{traces.length === 1 ? "" : "s"} · max{" "}
            <Text span c="gray.4" ff="monospace">
              {maxElapsed}ms
            </Text>
          </Text>
        </UnstyledButton>
      </Group>

      <Modal
        opened={opened}
        onClose={close}
        title="Page load requests"
        size="90vw"
        centered
      >
        <RequestTraceTable traces={traces} />
      </Modal>
    </>
  );
}

function RequestTraceTable({ traces }: { traces: MatchedRequestTrace[] }) {
  return (
    <Table.ScrollContainer className="kmc-table-scroll" minWidth={960} type="native">
      <Table className="kmc-table" highlightOnHover verticalSpacing={6} fz="xs" layout="fixed">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={80}>Method</Table.Th>
            <Table.Th w={70}>Status</Table.Th>
            <Table.Th w={90}>Elapsed</Table.Th>
            <Table.Th w={220}>Host</Table.Th>
            <Table.Th>Path</Table.Th>
            <Table.Th w={280}>Loader</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {traces.map((trace, i) => (
            <Table.Tr key={`${trace.method}:${trace.host ?? ""}:${trace.path}:${i}`}>
              <Table.Td>
                <Text span ff="monospace" size="xs">
                  {trace.method}
                </Text>
              </Table.Td>
              <Table.Td>
                {trace.error ? (
                  <Text size="xs" c="red">
                    err
                  </Text>
                ) : (
                  <Text size="xs" c={statusColor(trace.status)}>
                    {trace.status ?? "—"}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <Badge size="xs" variant="light" color={elapsedColor(trace.elapsedMs)}>
                  {trace.elapsedMs}ms
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed" lineClamp={1} title={trace.host}>
                  {trace.host ?? "—"}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text
                  size="xs"
                  ff="monospace"
                  style={{ overflowWrap: "anywhere" }}
                  title={trace.error ? `${trace.path} — ${trace.error}` : trace.path}
                >
                  {trace.path}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed" ff="monospace" title={trace.routeId}>
                  {formatRouteId(trace.routeId)}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function statusColor(status: number | undefined): string {
  if (status == null) return "dimmed";
  if (status >= 400) return "red";
  if (status >= 300) return "yellow";
  return "dimmed";
}
