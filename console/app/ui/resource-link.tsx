import { Anchor, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { Fragment } from "react";
import { Link } from "react-router";

/** In-console link to another resource or filtered list view. */
export function ResourceLink({
  to,
  children,
  dimmed = false,
  underline = "hover",
  size = "sm",
}: {
  to: string;
  children: ReactNode;
  /** Softer style for secondary identity fields (cluster, namespace). */
  dimmed?: boolean;
  underline?: "always" | "hover" | "never";
  size?: "xs" | "sm" | "md" | "lg" | "xl";
}) {
  return (
    <Anchor
      component={Link}
      to={to}
      size={size}
      c={dimmed ? "dimmed" : "accent.4"}
      fw={dimmed ? 400 : 600}
      underline={underline}
    >
      {children}
    </Anchor>
  );
}

/**
 * Breadcrumb-style identity under a detail page title
 * (e.g. `cluster / namespace` with each segment linked).
 */
export function ResourceIdentity({
  items,
  separator = " / ",
}: {
  items: Array<{ label: string; to?: string }>;
  separator?: string;
}) {
  return (
    <Text size="sm" c="dimmed" mt={4} component="div">
      {items.map((item, i) => (
        <Fragment key={`${item.label}-${i}`}>
          {i > 0 ? separator : null}
          {item.to ? (
            <ResourceLink to={item.to} dimmed>
              {item.label}
            </ResourceLink>
          ) : (
            item.label
          )}
        </Fragment>
      ))}
    </Text>
  );
}
