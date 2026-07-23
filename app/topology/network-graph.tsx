import { Badge, Box, Group, Stack, Text } from "@mantine/core";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { vpcPath, vmPath } from "~/lib/format";
import type {
  TopologyEdge,
  TopologyNetworkNode,
  TopologyVmNode,
} from "~/lib/types";

const NODE_W = 180;
const NODE_H = 52;
const ROW_GAP = 16;
const COL_GAP = 220;
const PAD_X = 24;
const PAD_Y = 28;
const HEADER_H = 22;

const KIND_COLORS: Record<TopologyNetworkNode["kind"], string> = {
  vpc: "#20c997",
  multus: "#339af0",
  pod: "#868e96",
};

const KIND_LABELS: Record<TopologyNetworkNode["kind"], string> = {
  vpc: "VPC",
  multus: "Multus",
  pod: "Pod",
};

const STATUS_STROKE: Record<string, string> = {
  Running: "#20c997",
  Starting: "#fcc419",
  Provisioning: "#fcc419",
  WaitingForVolumeBinding: "#fcc419",
  Migrating: "#22b8cf",
  Paused: "#be4bdb",
  Stopping: "#fd7e14",
  Terminating: "#fd7e14",
  Stopped: "#495057",
  Error: "#fa5252",
  CrashLoopBackOff: "#fa5252",
};

type LayoutNode = {
  id: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
};

function layoutColumn(
  ids: string[],
  x: number,
  startY: number,
): Map<string, LayoutNode> {
  const map = new Map<string, LayoutNode>();
  ids.forEach((id, i) => {
    const y = startY + i * (NODE_H + ROW_GAP);
    map.set(id, {
      id,
      x,
      y,
      cx: x + NODE_W / 2,
      cy: y + NODE_H / 2,
    });
  });
  return map;
}

function edgePath(
  from: LayoutNode,
  to: LayoutNode,
  fromRight: boolean,
): string {
  const x1 = fromRight ? from.x + NODE_W : from.x;
  const y1 = from.cy;
  const x2 = fromRight ? to.x : to.x + NODE_W;
  const y2 = to.cy;
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

function networkHref(n: TopologyNetworkNode): string | null {
  if (n.kind === "pod") return null;
  if (n.kind === "vpc" && n.exists !== false) {
    return vpcPath(n);
  }
  return null;
}

function networkSubtitle(n: TopologyNetworkNode): string {
  const bits: string[] = [];
  if (n.kind === "vpc" && n.vlan != null) bits.push(`vlan ${n.vlan}`);
  if (n.cidr) bits.push(n.cidr);
  if (n.exists === false) bits.push("missing NAD");
  if (bits.length === 0) {
    if (n.kind === "pod") return "default cluster network";
    if (n.kind === "multus") return "NetworkAttachmentDefinition";
    return "VPC";
  }
  return bits.join(" · ");
}

export function NetworkGraph({
  networks,
  vms,
  edges,
}: {
  networks: TopologyNetworkNode[];
  vms: TopologyVmNode[];
  edges: TopologyEdge[];
}) {
  const navigate = useNavigate();
  const [hoverId, setHoverId] = useState<string | null>(null);

  const related = useMemo(() => {
    if (!hoverId) return null;
    const nodeIds = new Set<string>([hoverId]);
    const edgeIds = new Set<string>();
    for (const e of edges) {
      if (e.networkId === hoverId || e.vmId === hoverId) {
        edgeIds.add(e.id);
        nodeIds.add(e.networkId);
        nodeIds.add(e.vmId);
      }
    }
    return { nodeIds, edgeIds };
  }, [hoverId, edges]);

  const layout = useMemo(() => {
    const netIds = networks.map((n) => n.id);
    const vmIds = vms.map((v) => v.id);
    const leftX = PAD_X;
    const rightX = PAD_X + NODE_W + COL_GAP;
    const startY = PAD_Y + HEADER_H;
    const netLayout = layoutColumn(netIds, leftX, startY);
    const vmLayout = layoutColumn(vmIds, rightX, startY);
    const rows = Math.max(netIds.length, vmIds.length, 1);
    const width = rightX + NODE_W + PAD_X;
    const height = startY + rows * (NODE_H + ROW_GAP) - ROW_GAP + PAD_Y;
    return { netLayout, vmLayout, width, height, leftX, rightX };
  }, [networks, vms]);

  const networkById = useMemo(
    () => new Map(networks.map((n) => [n.id, n] as const)),
    [networks],
  );
  const vmById = useMemo(
    () => new Map(vms.map((v) => [v.id, v] as const)),
    [vms],
  );

  if (networks.length === 0 && vms.length === 0) {
    return (
      <Box py="xl" ta="center">
        <Text size="sm" c="dimmed">
          No networks or VMs in this scope. Select a cluster and namespace, or
          create a VPC / launch a VM.
        </Text>
      </Box>
    );
  }

  const dimmed = (id: string) =>
    related != null && !related.nodeIds.has(id) ? 0.22 : 1;
  const edgeOpacity = (id: string) => {
    if (!related) return 0.55;
    return related.edgeIds.has(id) ? 0.95 : 0.08;
  };

  return (
    <Stack gap="sm">
      <Group gap="md" wrap="wrap">
        <Text size="xs" c="dimmed" tt="uppercase" style={{ letterSpacing: "0.06em" }}>
          Legend
        </Text>
        {(Object.keys(KIND_COLORS) as TopologyNetworkNode["kind"][]).map(
          (kind) => (
            <Group key={kind} gap={6}>
              <Box
                w={10}
                h={10}
                style={{
                  borderRadius: 2,
                  background: KIND_COLORS[kind],
                }}
              />
              <Text size="xs" c="dimmed">
                {KIND_LABELS[kind]}
              </Text>
            </Group>
          ),
        )}
        <Text size="xs" c="dimmed">
          · VM stroke = status
        </Text>
      </Group>

      <Box
        style={{
          overflow: "auto",
          maxWidth: "100%",
          borderRadius: 4,
          border: "1px solid #1e242c",
          background: "#0e1116",
        }}
      >
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label="Network topology graph"
          style={{ display: "block", minWidth: layout.width }}
        >
          <text
            x={layout.leftX}
            y={PAD_Y}
            fill="#868e96"
            fontSize={11}
            fontFamily="inherit"
            letterSpacing="0.06em"
          >
            NETWORKS
          </text>
          <text
            x={layout.rightX}
            y={PAD_Y}
            fill="#868e96"
            fontSize={11}
            fontFamily="inherit"
            letterSpacing="0.06em"
          >
            VIRTUAL MACHINES
          </text>

          {edges.map((e) => {
            const from = layout.netLayout.get(e.networkId);
            const to = layout.vmLayout.get(e.vmId);
            if (!from || !to) return null;
            const net = networkById.get(e.networkId);
            const stroke = net ? KIND_COLORS[net.kind] : "#868e96";
            return (
              <path
                key={e.id}
                d={edgePath(from, to, true)}
                fill="none"
                stroke={stroke}
                strokeWidth={related?.edgeIds.has(e.id) ? 2.25 : 1.5}
                opacity={edgeOpacity(e.id)}
                style={{ transition: "opacity 120ms ease, stroke-width 120ms ease" }}
              />
            );
          })}

          {networks.map((n) => {
            const pos = layout.netLayout.get(n.id);
            if (!pos) return null;
            const href = networkHref(n);
            const color = KIND_COLORS[n.kind];
            const opacity = dimmed(n.id);
            return (
              <g
                key={n.id}
                opacity={opacity}
                style={{
                  transition: "opacity 120ms ease",
                  cursor: href ? "pointer" : "default",
                }}
                onMouseEnter={() => setHoverId(n.id)}
                onMouseLeave={() => setHoverId(null)}
                onClick={() => {
                  if (href) navigate(href);
                }}
                role={href ? "link" : undefined}
                tabIndex={href ? 0 : undefined}
                onKeyDown={(ev) => {
                  if (!href) return;
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    navigate(href);
                  }
                }}
              >
                <title>
                  {n.name}
                  {n.namespace ? ` · ${n.namespace}` : ""}
                  {n.cluster ? ` · ${n.cluster}` : ""}
                </title>
                <rect
                  x={pos.x}
                  y={pos.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill="#12151a"
                  stroke={color}
                  strokeWidth={hoverId === n.id ? 2 : 1.25}
                  strokeDasharray={n.exists === false ? "4 3" : undefined}
                />
                <rect
                  x={pos.x}
                  y={pos.y}
                  width={4}
                  height={NODE_H}
                  rx={2}
                  fill={color}
                />
                <text
                  x={pos.x + 14}
                  y={pos.y + 20}
                  fill="#e9ecef"
                  fontSize={12}
                  fontFamily="inherit"
                  fontWeight={600}
                >
                  {truncate(n.name, 20)}
                </text>
                <text
                  x={pos.x + 14}
                  y={pos.y + 38}
                  fill="#868e96"
                  fontSize={10}
                  fontFamily="inherit"
                >
                  {truncate(networkSubtitle(n), 24)}
                </text>
              </g>
            );
          })}

          {vms.map((v) => {
            const pos = layout.vmLayout.get(v.id);
            if (!pos) return null;
            const stroke = STATUS_STROKE[v.status] ?? "#495057";
            const opacity = dimmed(v.id);
            const href = vmPath(v);
            return (
              <g
                key={v.id}
                opacity={opacity}
                style={{ transition: "opacity 120ms ease", cursor: "pointer" }}
                onMouseEnter={() => setHoverId(v.id)}
                onMouseLeave={() => setHoverId(null)}
                onClick={() => navigate(href)}
                role="link"
                tabIndex={0}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    navigate(href);
                  }
                }}
              >
                <title>
                  {v.name} · {v.status} · {v.namespace}/{v.cluster}
                </title>
                <rect
                  x={pos.x}
                  y={pos.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill="#12151a"
                  stroke={stroke}
                  strokeWidth={hoverId === v.id ? 2 : 1.25}
                />
                <circle
                  cx={pos.x + 14}
                  cy={pos.y + NODE_H / 2}
                  r={4}
                  fill={v.ready ? "#20c997" : stroke}
                />
                <text
                  x={pos.x + 26}
                  y={pos.y + 20}
                  fill="#e9ecef"
                  fontSize={12}
                  fontFamily="inherit"
                  fontWeight={600}
                >
                  {truncate(v.name, 18)}
                </text>
                <text
                  x={pos.x + 26}
                  y={pos.y + 38}
                  fill="#868e96"
                  fontSize={10}
                  fontFamily="inherit"
                >
                  {v.status}
                </text>
              </g>
            );
          })}
        </svg>
      </Box>

      {hoverId && (
        <HoverSummary
          hoverId={hoverId}
          networkById={networkById}
          vmById={vmById}
          edges={edges}
        />
      )}
    </Stack>
  );
}

function HoverSummary({
  hoverId,
  networkById,
  vmById,
  edges,
}: {
  hoverId: string;
  networkById: Map<string, TopologyNetworkNode>;
  vmById: Map<string, TopologyVmNode>;
  edges: TopologyEdge[];
}) {
  const net = networkById.get(hoverId);
  const vm = vmById.get(hoverId);

  if (net) {
    const attached = edges
      .filter((e) => e.networkId === hoverId)
      .map((e) => vmById.get(e.vmId)?.name)
      .filter(Boolean);
    return (
      <Group gap="xs" wrap="wrap">
        <Badge size="sm" variant="light" color={net.kind === "vpc" ? "teal" : net.kind === "pod" ? "gray" : "blue"}>
          {KIND_LABELS[net.kind]}
        </Badge>
        <Text size="sm" fw={600}>
          {net.name}
        </Text>
        <Text size="xs" c="dimmed">
          {net.namespace} · {net.cluster}
        </Text>
        <Text size="xs" c="dimmed">
          → {attached.length} VM{attached.length === 1 ? "" : "s"}
          {attached.length > 0 ? `: ${attached.slice(0, 8).join(", ")}` : ""}
          {attached.length > 8 ? "…" : ""}
        </Text>
      </Group>
    );
  }

  if (vm) {
    const nets = edges
      .filter((e) => e.vmId === hoverId)
      .map((e) => networkById.get(e.networkId)?.name)
      .filter(Boolean);
    return (
      <Group gap="xs" wrap="wrap">
        <Badge size="sm" variant="light" color={vm.ready ? "teal" : "gray"}>
          VM
        </Badge>
        <Text size="sm" fw={600}>
          {vm.name}
        </Text>
        <Text size="xs" c="dimmed">
          {vm.status} · {vm.namespace} · {vm.cluster}
        </Text>
        <Text size="xs" c="dimmed">
          ← {nets.length} network{nets.length === 1 ? "" : "s"}
          {nets.length > 0 ? `: ${nets.join(", ")}` : ""}
        </Text>
      </Group>
    );
  }

  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
