import { useId, useMemo, useState } from "react";
import { Group, Text } from "@mantine/core";
import type { MetricSeries } from "~/lib/prometheus/types";

const COLORS = ["#20c997", "#4dabf7", "#fab005", "#e599f7", "#ff6b6b", "#868e96"];

export type TimeSeriesChartProps = {
  series: MetricSeries[];
  height?: number;
  /** Format a raw y value for axis / tooltip. */
  formatValue: (v: number) => string;
  /** Format unix seconds for x axis. */
  formatTime?: (t: number) => string;
  emptyLabel?: string;
};

type HoverState = {
  index: number;
  t: number;
  values: Array<{ label: string; color: string; v: number }>;
};

function defaultFormatTime(t: number): string {
  const d = new Date(t * 1000);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  const n = max / base;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * base;
}

/**
 * Lightweight multi-series SVG line chart for the console UI (no chart lib).
 */
export function TimeSeriesChart({
  series,
  height = 160,
  formatValue,
  formatTime = defaultFormatTime,
  emptyLabel = "No data",
}: TimeSeriesChartProps) {
  const gradId = useId().replace(/:/g, "");
  const [hover, setHover] = useState<HoverState | null>(null);

  const layout = useMemo(() => {
    const pad = { top: 12, right: 12, bottom: 22, left: 52 };
    const width = 640; // viewBox width; scales via CSS
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    const active = series.filter((s) => s.points.length > 0);
    const allPoints = active.flatMap((s) => s.points);
    if (allPoints.length === 0) {
      return { pad, width, innerW, innerH, active, empty: true as const };
    }

    const tMin = Math.min(...allPoints.map((p) => p.t));
    const tMax = Math.max(...allPoints.map((p) => p.t));
    const vMaxRaw = Math.max(...allPoints.map((p) => p.v), 0);
    const vMax = niceMax(vMaxRaw * 1.08);
    const tSpan = Math.max(tMax - tMin, 1);

    const xOf = (t: number) => pad.left + ((t - tMin) / tSpan) * innerW;
    const yOf = (v: number) => pad.top + innerH - (Math.max(v, 0) / vMax) * innerH;

    const paths = active.map((s, i) => {
      const color = COLORS[i % COLORS.length]!;
      const pts = s.points;
      if (pts.length === 0) return { ...s, color, line: "", area: "" };
      const line = pts
        .map(
          (p, idx) =>
            `${idx === 0 ? "M" : "L"}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`,
        )
        .join(" ");
      const area =
        line +
        ` L${xOf(pts[pts.length - 1]!.t).toFixed(1)},${(pad.top + innerH).toFixed(1)}` +
        ` L${xOf(pts[0]!.t).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;
      return { ...s, color, line, area };
    });

    // Shared time grid from first series with the densest points
    const ref = active.reduce((a, b) => (a.points.length >= b.points.length ? a : b));
    const xTicks = 5;
    const yTicks = 4;
    const xTickVals = Array.from({ length: xTicks }, (_, i) =>
      Math.round(tMin + (tSpan * i) / (xTicks - 1)),
    );
    const yTickVals = Array.from({ length: yTicks }, (_, i) => (vMax * i) / (yTicks - 1));

    // Build time-aligned index for hover (use union of timestamps from densest series)
    const times = ref.points.map((p) => p.t);

    return {
      pad,
      width,
      innerW,
      innerH,
      active,
      empty: false as const,
      tMin,
      tMax,
      vMax,
      xOf,
      yOf,
      paths,
      xTickVals,
      yTickVals,
      times,
      ref,
    };
  }, [series, height]);

  if (layout.empty) {
    return (
      <div
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px dashed #1e242c",
          borderRadius: 4,
          background: "#0e1115",
        }}
      >
        <Text size="xs" c="dimmed">
          {emptyLabel}
        </Text>
      </div>
    );
  }

  const { pad, width, innerW, innerH, paths, xTickVals, yTickVals, times, xOf, yOf } =
    layout;

  function onMove(clientX: number, rect: DOMRect) {
    const svgX = ((clientX - rect.left) / rect.width) * width;
    const plotX = svgX - pad.left;
    if (plotX < 0 || plotX > innerW) {
      setHover(null);
      return;
    }
    // nearest time index
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < times.length; i++) {
      const dist = Math.abs(xOf(times[i]!) - svgX);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    const t = times[best]!;
    const values = paths.map((p) => {
      // nearest point in this series
      let nearest = p.points[0]!;
      let d = Infinity;
      for (const pt of p.points) {
        const dd = Math.abs(pt.t - t);
        if (dd < d) {
          d = dd;
          nearest = pt;
        }
      }
      return { label: p.label, color: p.color, v: nearest.v };
    });
    setHover({ index: best, t, values });
  }

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <Group gap="md" mb={6} wrap="wrap">
        {paths.map((p) => (
          <Group key={p.id} gap={6}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: p.color,
                display: "inline-block",
              }}
            />
            <Text size="xs" c="dimmed">
              {p.label}
            </Text>
          </Group>
        ))}
      </Group>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        style={{ display: "block", background: "#0e1115", borderRadius: 4 }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
        role="img"
      >
        <defs>
          {paths.map((p, i) => (
            <linearGradient key={p.id} id={`${gradId}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={p.color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={p.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>

        {/* grid */}
        {yTickVals.map((v, i) => {
          const y = yOf(v);
          return (
            <g key={`y-${i}`}>
              <line
                x1={pad.left}
                x2={pad.left + innerW}
                y1={y}
                y2={y}
                stroke="#1e242c"
                strokeWidth={1}
              />
              <text
                x={pad.left - 6}
                y={y + 3}
                textAnchor="end"
                fill="#868e96"
                fontSize={10}
                fontFamily="inherit"
              >
                {formatValue(v)}
              </text>
            </g>
          );
        })}
        {xTickVals.map((t, i) => (
          <text
            key={`x-${i}`}
            x={xOf(t)}
            y={height - 6}
            textAnchor="middle"
            fill="#868e96"
            fontSize={10}
            fontFamily="inherit"
          >
            {formatTime(t)}
          </text>
        ))}

        {/* areas + lines (domain last if present so it sits on top as guide) */}
        {paths.map((p, i) => (
          <g key={p.id}>
            {p.id !== "domain" && p.area && (
              <path d={p.area} fill={`url(#${gradId}-${i})`} stroke="none" />
            )}
            <path
              d={p.line}
              fill="none"
              stroke={p.color}
              strokeWidth={p.id === "domain" ? 1.25 : 1.75}
              strokeDasharray={p.id === "domain" ? "4 3" : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        ))}

        {/* hover crosshair */}
        {hover && (
          <g>
            <line
              x1={xOf(hover.t)}
              x2={xOf(hover.t)}
              y1={pad.top}
              y2={pad.top + innerH}
              stroke="#495057"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {hover.values.map((val, i) => {
              const p = paths[i];
              if (!p) return null;
              return (
                <circle
                  key={val.label}
                  cx={xOf(hover.t)}
                  cy={yOf(val.v)}
                  r={3}
                  fill={val.color}
                  stroke="#0e1115"
                  strokeWidth={1}
                />
              );
            })}
          </g>
        )}

        {/* invisible hit area */}
        <rect
          x={pad.left}
          y={pad.top}
          width={innerW}
          height={innerH}
          fill="transparent"
        />
      </svg>

      {hover && (
        <div
          style={{
            position: "absolute",
            top: 28,
            right: 12,
            background: "#12151a",
            border: "1px solid #1e242c",
            borderRadius: 4,
            padding: "6px 8px",
            pointerEvents: "none",
            minWidth: 120,
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
        >
          <Text size="xs" c="dimmed" mb={4}>
            {formatTime(hover.t)}
          </Text>
          {hover.values.map((v) => (
            <Group key={v.label} gap={6} justify="space-between" wrap="nowrap">
              <Group gap={6} wrap="nowrap">
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 1,
                    background: v.color,
                    display: "inline-block",
                  }}
                />
                <Text size="xs">{v.label}</Text>
              </Group>
              <Text size="xs" ff="monospace">
                {formatValue(v.v)}
              </Text>
            </Group>
          ))}
        </div>
      )}
    </div>
  );
}
