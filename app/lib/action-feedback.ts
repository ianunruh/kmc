import { notifications } from "@mantine/notifications";

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
