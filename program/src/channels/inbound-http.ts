import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";

import type { FastifyRequest } from "fastify";

/**
 * Shared protections of the public inbound routes (Teams messaging endpoint, Slack Events API, Telegram
 * webhook): the request source (socket address, or the client behind a configured trusted proxy) and a
 * per-source request budget (one per route), both checked in `onRequest`, before the body is read or parsed.
 */

/** Operator env: comma-separated IPs or CIDRs of the reverse proxies in front of Marketplace (Channels only). */
export const TRUSTED_PROXIES_ENV = "MARKETPLACE_TRUSTED_PROXIES";

const unmap = (address: string) => (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address);

/** Parses `MARKETPLACE_TRUSTED_PROXIES` into a block list; malformed entries are skipped. Null when none. */
export function parseTrustedProxies(value: string | null | undefined): BlockList | null {
  const list = new BlockList();
  let count = 0;
  for (const raw of (value ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const [address, prefix] = entry.split("/") as [string, string | undefined];
    const family = isIP(address);
    if (family === 0) continue;
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) {
      list.addAddress(address, type);
    } else {
      const bits = Number(prefix);
      if (!/^[0-9]{1,3}$/u.test(prefix) || bits > (family === 4 ? 32 : 128)) continue;
      list.addSubnet(address, bits, type);
    }
    count += 1;
  }
  return count > 0 ? list : null;
}

/** Which public inbound receivers are configured (booleans only; never a secret). */
export type InboundReceivers = { slack: boolean; telegram: boolean; teams: boolean };

/**
 * The startup warning for a receiver without trusted proxies, or null. Behind a reverse proxy (Railway's edge)
 * every request arrives from the proxy's socket address, so without `MARKETPLACE_TRUSTED_PROXIES` all senders
 * share one pre-auth budget per route and an anonymous flood can starve real deliveries. Names the receivers
 * and the variable only (structured, no secrets).
 */
export function trustedProxiesWarning(trusted: BlockList | null, receivers: InboundReceivers): { event: string; receivers: string[]; env: string; detail: string } | null {
  if (trusted) return null;
  const configured = (Object.keys(receivers) as Array<keyof InboundReceivers>).filter((name) => receivers[name]);
  if (configured.length === 0) return null;
  return {
    event: "marketplace.channels.inbound_trusted_proxies_unset",
    receivers: configured,
    env: TRUSTED_PROXIES_ENV,
    detail: `${TRUSTED_PROXIES_ENV} is unset or has no valid entry: behind a reverse proxy all senders share one pre-auth request budget per inbound route. Set it to the proxy address range.`,
  };
}

const isTrusted = (trusted: BlockList | null, address: string) => {
  if (!trusted) return false;
  const plain = unmap(address);
  const family = isIP(plain);
  return family !== 0 && trusted.check(plain, family === 4 ? "ipv4" : "ipv6");
};

/** One `X-Forwarded-For` entry as an IP: `ip:port` and `[v6]:port` lose the port; null when it is not an IP. */
function forwardedAddress(entry: string): string | null {
  const text = entry.trim();
  const bracketed = /^\[([^\]]+)\](?::[0-9]{1,5})?$/u.exec(text);
  const v4Port = /^([0-9.]+):[0-9]{1,5}$/u.exec(text);
  const candidate = unmap(bracketed ? bracketed[1]! : v4Port && isIP(v4Port[1]!) === 4 ? v4Port[1]! : text);
  return isIP(candidate) === 0 ? null : candidate;
}

/**
 * The request's source for the per-source budget (review F2). The socket's remote address, unless that address
 * is a configured trusted proxy: then the right-most `X-Forwarded-For` entry that is not itself a trusted proxy.
 * Entries may carry a port (`ip:port`, `[v6]:port`); it is dropped before the IP check. The walk goes from the
 * right and stops at the first entry that is still not an IP: everything left of it is client-controlled, so the
 * source is then the socket address. Without trusted proxies the header is ignored, so a client cannot pick its
 * own budget key. Channels-local: Fastify's app-wide `trustProxy` is not changed.
 */
export function createSourceResolver(trusted: BlockList | null) {
  return (request: FastifyRequest): string => {
    const remote = unmap(request.socket?.remoteAddress ?? request.raw.socket?.remoteAddress ?? "unknown");
    if (!isTrusted(trusted, remote)) return remote;
    const header = request.headers["x-forwarded-for"];
    const entries = (Array.isArray(header) ? header.join(",") : header ?? "").split(",");
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const address = forwardedAddress(entries[index]!);
      if (address === null) return remote;
      if (!isTrusted(trusted, address)) return address;
    }
    return remote;
  };
}

export type SourceRate = { capacity: number; refillPerSecond: number };

/** Most sources one budget tracks; beyond it the least recently seen source is evicted (never everyone at once). */
export const SOURCE_BUDGET_MAX_SOURCES = 10_000;

/** A token bucket per source address, LRU-bounded. `take(source)` is false when the source is over budget. */
export function createSourceBudget(rate: SourceRate, clock: () => number = () => Date.now(), maxSources = SOURCE_BUDGET_MAX_SOURCES) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(source: string): boolean {
      const now = clock();
      const bucket = buckets.get(source) ?? { tokens: rate.capacity, at: now };
      bucket.tokens = Math.min(rate.capacity, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * rate.refillPerSecond);
      bucket.at = now;
      // Re-insert so the Map's order is least recently seen first.
      buckets.delete(source);
      buckets.set(source, bucket);
      while (buckets.size > maxSources) buckets.delete(buckets.keys().next().value as string);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
    get size(): number {
      return buckets.size;
    },
  };
}

/** The first value of a request header, or undefined. */
export function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : undefined;
}

/** The consumer identity of a bot credential: `<provider>:<first 32 hex of sha256(credential)>` (never the credential). */
export function inboundConsumerKey(provider: string, credential: string): string {
  return `${provider}:${createHash("sha256").update(credential, "utf8").digest("hex").slice(0, 32)}`;
}

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Constant-time: does sha256(value) equal the stored hex digest? */
export function matchesDigest(value: string, digestHex: string): boolean {
  const left = createHash("sha256").update(value, "utf8").digest();
  const right = Buffer.from(digestHex, "hex");
  return right.length === left.length && timingSafeEqual(left, right);
}
