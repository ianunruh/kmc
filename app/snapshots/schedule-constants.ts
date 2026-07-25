/** UI + validation constants for VM snapshot schedules (safe for client import). */

/** Standard 5-field cron presets (UTC). */
export const SNAPSHOT_SCHEDULE_PRESETS: Array<{ value: string; label: string }> = [
  { value: "0 * * * *", label: "Hourly" },
  { value: "0 */6 * * *", label: "Every 6 hours" },
  { value: "0 3 * * *", label: "Daily at 03:00 UTC" },
  { value: "0 3 * * 0", label: "Weekly (Sunday 03:00 UTC)" },
];

export const SNAPSHOT_SCHEDULE_RETAIN_MIN = 1;
export const SNAPSHOT_SCHEDULE_RETAIN_MAX = 30;
export const SNAPSHOT_SCHEDULE_RETAIN_DEFAULT = 7;

/** Human-readable preset label for a cron string, if known. */
export function cronPresetLabel(cron: string): string | undefined {
  return SNAPSHOT_SCHEDULE_PRESETS.find((p) => p.value === cron)?.label;
}
