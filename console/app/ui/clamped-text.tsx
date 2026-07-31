import { Text, Tooltip, type TextProps } from "@mantine/core";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Text that clamps to N lines and, when actually overflowing, shows the full
 * value in a tooltip on hover/focus/touch. Prefer this over bare `lineClamp`
 * in tables so truncated cells stay readable.
 */
export function ClampedText({
  children,
  lineClamp = 1,
  tooltip,
  maw,
  ...textProps
}: {
  children: ReactNode;
  lineClamp?: number;
  /** Full text for the tooltip. Defaults to string/number children. */
  tooltip?: string;
  maw?: TextProps["maw"];
} & Omit<TextProps, "lineClamp" | "children" | "maw">) {
  const ref = useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = useState(false);

  const label =
    tooltip ??
    (typeof children === "string" || typeof children === "number"
      ? String(children)
      : undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      // +1 tolerance avoids false positives from subpixel rounding
      setTruncated(
        el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
      );
    };

    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [children, lineClamp, label, maw]);

  const content = (
    <Text ref={ref} component="div" lineClamp={lineClamp} maw={maw} {...textProps}>
      {children}
    </Text>
  );

  if (!truncated || !label?.trim()) {
    return content;
  }

  return (
    <Tooltip
      label={label}
      multiline
      maw={480}
      withArrow
      openDelay={250}
      events={{ hover: true, focus: true, touch: true }}
      // Keep the clamped node as the target so table layout is unchanged.
      position="top-start"
    >
      {content}
    </Tooltip>
  );
}
