/**
 * Flatten Error.message + nested cause chain into a single string.
 * e.g. "fetch failed: unable to verify the first certificate"
 */
export function formatError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.message) parts.push(current.message);
      current = current.cause;
      continue;
    }
    if (typeof current === "object" && current !== null && "message" in current) {
      const msg = (current as { message?: unknown }).message;
      if (msg) parts.push(String(msg));
      current =
        "cause" in current ? (current as { cause?: unknown }).cause : undefined;
      continue;
    }
    parts.push(String(current));
    break;
  }

  // de-dupe consecutive identical segments
  const deduped = parts.filter((p, i) => p && p !== parts[i - 1]);
  return deduped.join(": ") || "Unknown error";
}

export function errorStack(err: unknown): string | undefined {
  if (err instanceof Error && err.stack) return err.stack;
  return undefined;
}

/**
 * Log to the server terminal (react-router / vite process) and return a
 * client-safe message built from the full cause chain.
 */
export function logServerError(
  scope: string,
  err: unknown,
  meta?: Record<string, unknown>,
): string {
  const message = formatError(err);
  const stack = errorStack(err);
  // Structured line so it greps easily in dev server logs
  console.error(
    `[kmc:error] ${scope}`,
    JSON.stringify({ message, ...meta }, null, 0),
  );
  if (stack) {
    console.error(stack);
  }
  return message;
}

export type ActionFailure = {
  ok: false;
  error: string;
  intent?: string;
};

export type ActionSuccess = {
  ok: true;
  intent?: string;
};

export type ActionResult = ActionFailure | ActionSuccess;

export function actionFailure(
  scope: string,
  err: unknown,
  meta?: Record<string, unknown> & { intent?: string },
): ActionFailure {
  const { intent, ...rest } = meta ?? {};
  const error = logServerError(scope, err, { intent, ...rest });
  return { ok: false, error, intent };
}
