import { notifications } from "@mantine/notifications";
import type { BulkActionSummary, BulkItemResult } from "~/lib/types";

/**
 * Surface action failures in the UI and the browser console.
 * Toast alone is easy to miss while debugging — always console.error too.
 */
export function notifyActionError(
  title: string,
  error: string,
  context?: Record<string, unknown>,
): void {
  console.error(`[kmc:error] ${title}`, error, context ?? "");
  notifications.show({
    color: "red",
    title,
    message: error,
    autoClose: 12_000,
    withCloseButton: true,
  });
}

export function notifyActionSuccess(title: string, message: string): void {
  notifications.show({
    color: "teal",
    title,
    message,
    autoClose: 4_000,
  });
}

/**
 * One summary toast for a bulk action (done / skipped / failed).
 * Prefer this over N per-item toasts.
 */
export function notifyBulkResult(
  verb: string,
  summary: BulkActionSummary,
  results?: BulkItemResult[],
): void {
  const parts: string[] = [];
  if (summary.succeeded > 0) parts.push(`${summary.succeeded} ${verb}`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  const message =
    parts.length > 0 ? parts.join(" · ") : `No resources ${verb}`;

  const firstFailure = results?.find((r) => r.status === "failed" && r.error);
  const detail =
    firstFailure?.error != null
      ? `${message}. First error (${firstFailure.name}): ${firstFailure.error}`
      : message;

  if (summary.failed > 0 && summary.succeeded === 0) {
    notifyActionError("Bulk action failed", detail, { summary });
    return;
  }
  if (summary.failed > 0) {
    notifications.show({
      color: "orange",
      title: "Bulk action partial",
      message: detail,
      autoClose: 12_000,
      withCloseButton: true,
    });
    return;
  }
  notifyActionSuccess("Done", message);
}
