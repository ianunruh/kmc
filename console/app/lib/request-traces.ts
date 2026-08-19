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
  matches: Array<{ id: string; data?: unknown }>,
): MatchedRequestTrace[] {
  const out: MatchedRequestTrace[] = [];
  for (const match of matches) {
    const data = match.data as { traces?: RequestTrace[] } | null | undefined;
    if (!data?.traces?.length) continue;
    for (const trace of data.traces) {
      out.push({ ...trace, routeId: match.id });
    }
  }
  return out;
}
