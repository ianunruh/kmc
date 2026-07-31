import { Text } from "@mantine/core";
import type { ReactNode } from "react";

export function DetailField({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed" mb={2}>
        {label}
      </Text>
      {/* div — Text defaults to <p>, which cannot wrap Badge/divs */}
      <Text component="div" size="sm" style={{ wordBreak: "break-word" }}>
        {value ?? "—"}
      </Text>
    </div>
  );
}
