/** IPv4 helpers for pool windows and IPAddress claims (no external deps). */

export type ParsedCidr = {
  /** Dotted CIDR as configured */
  cidr: string;
  /** Network address as uint32 */
  network: number;
  prefix: number;
  mask: number;
  /** First address in the block (network) */
  first: number;
  /** Last address in the block (broadcast for prefix < 31) */
  last: number;
};

export function parseIpv4(ip: string): number {
  const s = ip.trim();
  const parts = s.split(".");
  if (parts.length !== 4) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  let n = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      throw new Error(`Invalid IPv4 address: ${ip}`);
    }
    const o = Number(part);
    if (!Number.isInteger(o) || o < 0 || o > 255) {
      throw new Error(`Invalid IPv4 address: ${ip}`);
    }
    n = ((n << 8) + o) >>> 0;
  }
  return n >>> 0;
}

export function formatIpv4(n: number): string {
  const x = n >>> 0;
  return [(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff].join(
    ".",
  );
}

export function parseCidr(cidr: string): ParsedCidr {
  const raw = cidr.trim();
  const slash = raw.indexOf("/");
  if (slash <= 0) {
    throw new Error(`Invalid CIDR (expected a.b.c.d/nn): ${cidr}`);
  }
  const ip = raw.slice(0, slash);
  const prefix = Number(raw.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR prefix: ${cidr}`);
  }
  const addr = parseIpv4(ip);
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  const network = (addr & mask) >>> 0;
  const hostBits = 32 - prefix;
  const size = hostBits === 32 ? 0x100000000 : 1 << hostBits;
  const last = (network + size - 1) >>> 0;
  return {
    cidr: `${formatIpv4(network)}/${prefix}`,
    network,
    prefix,
    mask,
    first: network,
    last,
  };
}

export function containsIpv4(parsed: ParsedCidr, ip: string | number): boolean {
  const n = typeof ip === "number" ? ip >>> 0 : parseIpv4(ip);
  return n >= parsed.first && n <= parsed.last;
}

/** Strip optional /prefix from "1.2.3.4" or "1.2.3.4/24". */
export function addressFromIpv4Annotation(value: string): string | null {
  const s = value.trim();
  if (!s) return null;
  const base = s.includes("/") ? s.slice(0, s.indexOf("/")) : s;
  try {
    parseIpv4(base);
    return base;
  } catch {
    return null;
  }
}

export type HostRange = {
  /** Inclusive first usable host (uint32) */
  start: number;
  /** Inclusive last usable host (uint32) */
  end: number;
};

/**
 * Usable hosts in a CIDR, optionally narrowed by start/end addresses.
 * Excludes network + broadcast for prefix ≤ 30.
 */
export function usableHostRange(
  parsed: ParsedCidr,
  opts?: { start?: string; end?: string },
): HostRange {
  let start = parsed.first;
  let end = parsed.last;

  if (parsed.prefix <= 30) {
    start = (parsed.first + 1) >>> 0;
    end = (parsed.last - 1) >>> 0;
  }

  if (opts?.start) {
    const s = parseIpv4(opts.start);
    if (!containsIpv4(parsed, s)) {
      throw new Error(`Pool start ${opts.start} is outside ${parsed.cidr}`);
    }
    start = Math.max(start, s) >>> 0;
  }
  if (opts?.end) {
    const e = parseIpv4(opts.end);
    if (!containsIpv4(parsed, e)) {
      throw new Error(`Pool end ${opts.end} is outside ${parsed.cidr}`);
    }
    end = Math.min(end, e) >>> 0;
  }

  if (start > end) {
    throw new Error(`No usable hosts in ${parsed.cidr} with the given start/end`);
  }

  return { start, end };
}

export function countUsableHosts(range: HostRange): number {
  return range.end - range.start + 1;
}

/** First free address in range not present in `used` (dotted strings). */
export function firstFreeIpv4(
  range: HostRange,
  used: ReadonlySet<string>,
  extraExclude: ReadonlySet<string> = new Set(),
): string | null {
  for (let n = range.start; n <= range.end; n++) {
    const ip = formatIpv4(n);
    if (used.has(ip) || extraExclude.has(ip)) continue;
    return ip;
  }
  return null;
}
