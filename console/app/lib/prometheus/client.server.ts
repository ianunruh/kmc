/**
 * Minimal Prometheus HTTP API client (instant + range queries).
 * Server-only — base URL (+ optional SA JWT) comes from the cluster registry.
 */

import { requestInfoFromUrl, timedRequest } from "~/lib/request-traces.server";

export type PromClient = {
  url: string;
  /** Platform SA token; sent as Bearer for edge-sso JWT policies. */
  token?: string;
};

export type PromMetric = Record<string, string>;

export type PromInstantSample = {
  metric: PromMetric;
  value: [number, string];
};

export type PromRangeSample = {
  metric: PromMetric;
  values: Array<[number, string]>;
};

type PromResponse<T> = {
  status: "success" | "error";
  data?: T;
  errorType?: string;
  error?: string;
};

const DEFAULT_TIMEOUT_MS = 15_000;

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  return `${b}${path.startsWith("/") ? path : `/${path}`}`;
}

function requestHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function promFetch<T>(
  client: PromClient,
  path: string,
  params: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = new URL(joinUrl(client.url, path));
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Do not follow redirects: SSO/oauth2-proxy frontends 302 to login pages,
    // and those often respond 406 to Accept: application/json (GitHub OAuth).
    const res = await timedRequest(
      requestInfoFromUrl("GET", url.toString()),
      () =>
        fetch(url, {
          signal: controller.signal,
          headers: requestHeaders(client.token),
          redirect: "manual",
        }),
      (r) => r.status,
    );
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "";
      const hint = /oauth|sso|login/i.test(location)
        ? client.token
          ? " (SSO frontend rejected the cluster SA JWT — allowlist kmc-system/kmc on the Prom/AM SecurityPolicy)"
          : " (SSO frontend — send the cluster SA token as Bearer, or set prometheusUrl to an in-cluster Prometheus service)"
        : "";
      throw new Error(
        `Prometheus redirected HTTP ${res.status}${location ? ` → ${location.slice(0, 160)}` : ""}${hint}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Prometheus HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
      );
    }
    const json = (await res.json()) as PromResponse<T>;
    if (json.status !== "success" || json.data == null) {
      throw new Error(json.error ?? "Prometheus query failed");
    }
    return json.data;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Prometheus request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function promQuery(
  client: PromClient,
  query: string,
  time?: number,
): Promise<PromInstantSample[]> {
  const params: Record<string, string> = { query };
  if (time != null) params.time = String(time);
  const data = await promFetch<{ resultType: string; result: PromInstantSample[] }>(
    client,
    "/api/v1/query",
    params,
  );
  return data.result ?? [];
}

export async function promQueryRange(
  client: PromClient,
  query: string,
  start: number,
  end: number,
  step: number,
): Promise<PromRangeSample[]> {
  const data = await promFetch<{ resultType: string; result: PromRangeSample[] }>(
    client,
    "/api/v1/query_range",
    {
      query,
      start: String(start),
      end: String(end),
      step: String(step),
    },
  );
  return data.result ?? [];
}

/** Escape a value for use inside a Prometheus double-quoted label matcher. */
export function promEscapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
