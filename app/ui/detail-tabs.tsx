import { Group } from "@mantine/core";
import { NavLink } from "react-router";

export type DetailTabItem = {
  label: string;
  to: string;
  /** Match path exactly (use for the overview index). */
  end?: boolean;
};

/** URL-driven tab strip shared by resource detail layouts. */
export function DetailTabs({ items }: { items: DetailTabItem[] }) {
  return (
    <Group gap={0} style={{ borderBottom: "1px solid #1e242c" }}>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          style={({ isActive }) => ({
            textDecoration: "none",
            color: isActive
              ? "var(--mantine-color-teal-4)"
              : "var(--mantine-color-dimmed)",
            borderBottom: isActive
              ? "2px solid var(--mantine-color-teal-5)"
              : "2px solid transparent",
            padding: "8px 14px",
            fontSize: "var(--mantine-font-size-sm)",
            fontWeight: isActive ? 600 : 500,
            marginBottom: -1,
          })}
        >
          {item.label}
        </NavLink>
      ))}
    </Group>
  );
}
