import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { Agent, fetch as undiciFetch, WebSocket as UndiciWebSocket } from "undici";

import { expandIpv6, isForbiddenMcpAddress } from "../mcp-url-policy.js";
import type { GatewaySocket, GatewaySocketFactory } from "./discord-gateway.js";

/**
 * Egress guard for the owner's Buzz relay (Coordinator relay rules, 2026-10-10). There is no fixed allowlist
 * (customers run their own relays), but:
 *
 * - `wss://` only (normalizeRelayUrl);
 * - in production every address the relay host resolves to (A and AAAA; every one of them) must be public:
 *   loopback, unspecified, RFC 1918, IPv6 ULA fc00::/7, link-local 169.254/16 and fe80::/10 (cloud metadata
 *   169.254.169.254, fd00:ec2::254), CGNAT 100.64/10, multicast/reserved, IPv4-mapped/NAT64 forms of those,
 *   and metadata or local names (`metadata.google.internal`, `*.internal`, `localhost`, `*.local`, single-label)
 *   are refused. IP-literal hosts get the same checks;
 * - the check runs when the owner sets the relay AND again at every connect: the HTTP agent and the WebSocket
 *   resolve right before each connection through `guardedLookup`, check every answer, and connect to the checked
 *   address (pinned), so a DNS change cannot bypass it;
 * - development may allow private relays only with `MARKETPLACE_CHANNELS_BUZZ_ALLOW_PRIVATE_RELAY=1`, env only
 *   (never a manifest setting, so Portal cannot set it), off by default, ignored when `NODE_ENV=production`.
 */

export const BUZZ_ALLOW_PRIVATE_RELAY_ENV = "MARKETPLACE_CHANNELS_BUZZ_ALLOW_PRIVATE_RELAY";

export type RelayLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export const defaultRelayLookup: RelayLookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** The dev-only flag: on only when set to 1/true AND `NODE_ENV` is exactly `development` or `test` (unset: off). */
export function buzzPrivateRelayAllowed(env: Record<string, string | undefined>): boolean {
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") return false;
  return /^(1|true)$/iu.test(env[BUZZ_ALLOW_PRIVATE_RELAY_ENV]?.trim() ?? "");
}

const dotted = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

/**
 * The IPv4 address an IPv6 address carries, whatever the notation (hex or dotted): IPv4-mapped ::ffff:0:0/96,
 * IPv4-compatible ::/96, NAT64 64:ff9b::/96 and 64:ff9b:1::/48 (last 32 bits), 6to4 2002::/16 (bits 16–48) and
 * Teredo 2001::/32 (client address: the last 32 bits inverted). Null when none.
 */
export function embeddedIpv4(address: string): string | null {
  const groups = expandIpv6(address.replace(/^\[|\]$/gu, ""));
  if (!groups) return null;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  if (zeros(0, 5) && g5 === 0xffff) return dotted(g6, g7);
  if (zeros(0, 6) && !(g6 === 0 && (g7 === 0 || g7 === 1))) return dotted(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b && zeros(2, 6)) return dotted(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return dotted(g6, g7);
  if (g0 === 0x2002) return dotted(g1, g2);
  if (g0 === 0x2001 && g1 === 0) return dotted(~g6 & 0xffff, ~g7 & 0xffff);
  void g3;
  void g4;
  return null;
}

function cgnat(address: string): boolean {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

/** True when the relay may not be contacted at this address (production rules). */
export function isBlockedRelayAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/gu, "").split("%")[0] ?? "";
  const family = isIP(bare);
  if (family === 0) return true;
  if (family === 4) return isForbiddenMcpAddress(bare) || cgnat(bare);
  // Local-use NAT64 64:ff9b:1::/48 (RFC 8215) is never a public relay, whatever the embedding layout.
  const groups = expandIpv6(bare);
  if (groups && groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return true;
  // IPv6 carrying an IPv4 address (mapped, compatible, NAT64, 6to4, Teredo): every IPv4 rule applies to it.
  const embedded = embeddedIpv4(bare);
  if (embedded !== null && isBlockedRelayAddress(embedded)) return true;
  return isForbiddenMcpAddress(bare);
}

const METADATA_NAMES = new Set(["metadata.google.internal", "metadata.goog", "metadata", "instance-data", "instance-data.ec2.internal"]);

/** Names that are never a public relay (refused before DNS). */
export function isBlockedRelayHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "").replace(/^\[|\]$/gu, "");
  if (isIP(host) !== 0) return isBlockedRelayAddress(host);
  return (
    host === "" ||
    METADATA_NAMES.has(host) ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    !host.includes(".")
  );
}

export type RelayHostCheck = { ok: true; addresses: string[] } | { ok: false; reason: "relay_host_blocked" | "relay_address_blocked" | "relay_dns_failed" };

/** Resolves the host and checks every answer (A and AAAA). With `allowPrivate` (dev flag) only resolution is required. */
export async function checkRelayHost(hostname: string, options: { allowPrivate: boolean; lookup?: RelayLookup }): Promise<RelayHostCheck> {
  const host = hostname.replace(/^\[|\]$/gu, "");
  if (!options.allowPrivate && isBlockedRelayHostname(host)) return { ok: false, reason: "relay_host_blocked" };
  let answers: ReadonlyArray<{ address: string; family: number }>;
  try {
    answers = isIP(host) !== 0 ? [{ address: host, family: isIP(host) }] : await (options.lookup ?? defaultRelayLookup)(host);
  } catch {
    return { ok: false, reason: "relay_dns_failed" };
  }
  if (answers.length === 0) return { ok: false, reason: "relay_dns_failed" };
  if (!options.allowPrivate && answers.some((answer) => isBlockedRelayAddress(answer.address))) return { ok: false, reason: "relay_address_blocked" };
  return { ok: true, addresses: answers.map((answer) => answer.address) };
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

/**
 * `net.connect` / `tls.connect` lookup: resolves again at every connect, refuses when ANY answer is blocked, and
 * hands back only checked addresses, so the socket connects to an address that passed the check (pinned).
 */
export function guardedLookup(options: { allowPrivate: boolean; lookup?: RelayLookup }) {
  return (hostname: string, lookupOptions: { all?: boolean } | number | undefined, callback: LookupCallback) => {
    const all = typeof lookupOptions === "object" && lookupOptions !== null && lookupOptions.all === true;
    void checkRelayHost(hostname, options).then((checked) => {
      if (!checked.ok) {
        callback(Object.assign(new Error(checked.reason), { code: checked.reason === "relay_dns_failed" ? "ENOTFOUND" : "EADDRNOTAVAIL" }), "");
        return;
      }
      const answers = checked.addresses.map((address) => ({ address, family: isIP(address) }));
      if (all) callback(null, answers);
      else callback(null, answers[0]!.address, answers[0]!.family);
    });
  };
}

/** An undici agent whose every connection goes through `guardedLookup` (TLS still verifies the relay name). */
export function guardedRelayAgent(options: { allowPrivate: boolean; lookup?: RelayLookup }): Agent {
  return new Agent({ connect: { lookup: guardedLookup(options) as never } });
}

/**
 * Node does no DNS lookup for an IP-literal host, so the guarded lookup never sees it: check literals here,
 * at every connect, in addition to the check when the owner sets the relay.
 */
export function relayLiteralBlocked(target: string | URL | Request, allowPrivate: boolean): boolean {
  if (allowPrivate) return false;
  let hostname: string;
  try {
    hostname = new URL(typeof target === "string" || target instanceof URL ? target : target.url).hostname;
  } catch {
    return true;
  }
  const bare = hostname.replace(/^\[|\]$/gu, "");
  return isIP(bare) !== 0 && isBlockedRelayAddress(bare);
}

export class RelayAddressBlockedError extends Error {
  readonly code = "relay_address_blocked";
  constructor() {
    super("relay_address_blocked");
  }
}

/** The adapter's default fetch: undici through the guarded agent; redirects are refused by the caller. */
export function guardedRelayFetch(options: { allowPrivate: boolean; lookup?: RelayLookup }): typeof fetch {
  const dispatcher = guardedRelayAgent(options);
  return ((input: string | URL | Request, init?: RequestInit) => {
    if (relayLiteralBlocked(input, options.allowPrivate)) return Promise.reject(new RelayAddressBlockedError());
    return undiciFetch(input as never, { ...((init ?? {}) as object), dispatcher } as never) as unknown as Promise<Response>;
  }) as typeof fetch;
}

/** The relay socket's default factory: undici's WebSocket through the guarded agent. */
export function guardedRelaySocketFactory(options: { allowPrivate: boolean; lookup?: RelayLookup }): GatewaySocketFactory {
  const dispatcher = guardedRelayAgent(options);
  return (url) => {
    if (relayLiteralBlocked(url, options.allowPrivate)) throw new RelayAddressBlockedError();
    return new UndiciWebSocket(url, { dispatcher }) as unknown as GatewaySocket;
  };
}
