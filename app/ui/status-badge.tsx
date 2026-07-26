import { Badge } from "@mantine/core";

const STATUS_COLORS: Record<string, string> = {
  Running: "teal",
  Ready: "teal",
  Succeeded: "teal",
  Starting: "yellow",
  Provisioning: "yellow",
  WaitingForVolumeBinding: "yellow",
  Pending: "yellow",
  InProgress: "yellow",
  Migrating: "cyan",
  Paused: "grape",
  Stopping: "orange",
  Terminating: "orange",
  Stale: "orange",
  NotReady: "orange",
  Stopped: "gray",
  Error: "red",
  Failed: "red",
  CrashLoopBackOff: "red",
  Unknown: "gray",
};

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "gray";
  return (
    <Badge
      color={color}
      variant="light"
      size="sm"
      radius="sm"
      tt="uppercase"
      style={{ fontFamily: "inherit", letterSpacing: "0.04em" }}
    >
      {status || "Unknown"}
    </Badge>
  );
}
