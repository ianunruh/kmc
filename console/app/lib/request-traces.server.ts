import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestTrace } from "./request-traces";

export type { RequestTrace };

const storage = new AsyncLocalStorage<RequestTrace[]>();

export function getRequestTraces(): RequestTrace[] {
  return [...(storage.getStore() ?? [])];
}

export function recordRequestTrace(trace: RequestTrace): void {
  storage.getStore()?.push(trace);
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

/** Time a backend call and record it on the current loader's trace list. */
export async function timedRequest<T>(
  info: Pick<RequestTrace, "method" | "path" | "host">,
  fn: () => Promise<T>,
  statusOf?: (result: T) => number | undefined,
): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    recordRequestTrace({
      method: info.method,
      path: info.path,
      host: info.host,
      status: statusOf?.(result),
      elapsedMs: elapsedMs(started),
    });
    return result;
  } catch (err) {
    recordRequestTrace({
      method: info.method,
      path: info.path,
      host: info.host,
      elapsedMs: elapsedMs(started),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Isolate request collection for one loader and attach `traces` to its
 * returned data object. Parallel loaders each get their own list.
 */
export function tracedLoader<Args, Data>(
  loaderFn: (args: Args) => Promise<Data>,
): (
  args: Args,
) => Promise<
  Data extends Response
    ? Data
    : Data extends object
      ? Data & { traces: RequestTrace[] }
      : Data
> {
  return async (args: Args) => {
    return storage.run([] as RequestTrace[], async () => {
      const result = await loaderFn(args);
      if (result instanceof Response) {
        return result as never;
      }
      if (result !== null && typeof result === "object" && !Array.isArray(result)) {
        return { ...result, traces: getRequestTraces() } as never;
      }
      return result as never;
    });
  };
}

export function requestInfoFromUrl(
  method: string,
  rawUrl: string,
): Pick<RequestTrace, "method" | "path" | "host"> {
  try {
    const url = new URL(rawUrl);
    return {
      method: method.toUpperCase(),
      path: `${url.pathname}${url.search}`,
      host: url.host,
    };
  } catch {
    return { method: method.toUpperCase(), path: rawUrl };
  }
}
