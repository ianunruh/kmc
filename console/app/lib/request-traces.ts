export type RequestTrace = {
  method: string;
  path: string;
  host?: string;
  status?: number;
  elapsedMs: number;
  error?: string;
};

export type MatchedRequestTrace = RequestTrace & {
  routeId: string;
};

export function tracesFromMatches(
  matches: Array<{ id: string; data?: unknown; loaderData?: unknown }>,
): MatchedRequestTrace[] {
  const out: MatchedRequestTrace[] = [];
  for (const match of matches) {
    // React Router 7+ exposes loader results as `loaderData`; older Remix used `data`.
    const raw = match.loaderData ?? match.data;
    const data = raw as { traces?: RequestTrace[] } | null | undefined;
    if (!data?.traces?.length) continue;
    for (const trace of data.traces) {
      out.push({ ...trace, routeId: match.id });
    }
  }
  return out;
}
