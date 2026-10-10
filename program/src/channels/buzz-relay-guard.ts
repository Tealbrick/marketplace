import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { Agent, fetch as undiciFetch, WebSocket as UndiciWebSocket } from "undici";

import { isForbiddenMcpAddress } from "../mcp-url-policy.js";
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

/** The dev-only flag: on only when set to 1/true AND not in production. */
export function buzzPrivateRelayAllowed(env: Record<string, string | undefined>): boolean {
  if (env.NODE_ENV === "production") return false;
  return /^(1|true)$/iu.test(env[BUZZ_ALLOW_PRIVATE_RELAY_ENV]?.trim() ?? "");
}

function cgnat(address: string): boolean {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

/** True when the relay may not be contacted at this address (production rules). */
export function isBlockedRelayAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/gu, "");
  if (isIP(bare) === 0) return true;
  if (isForbiddenMcpAddress(bare)) return true;
  if (isIP(bare) === 4 && cgnat(bare)) return true;
  // IPv4-mapped / NAT64 CGNAT (isForbiddenMcpAddress allows CGNAT for tailnets; Buzz does not).
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/iu.exec(bare)?.[1];
  return mapped !== undefined && cgnat(mapped);
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

/** The adapter's default fetch: undici through the guarded agent; redirects are refused by the caller. */
export function guardedRelayFetch(options: { allowPrivate: boolean; lookup?: RelayLookup }): typeof fetch {
  const dispatcher = guardedRelayAgent(options);
  return ((input: string | URL | Request, init?: RequestInit) => undiciFetch(input as never, { ...((init ?? {}) as object), dispatcher } as never) as unknown as Promise<Response>) as typeof fetch;
}

/** The relay socket's default factory: undici's WebSocket through the guarded agent. */
export function guardedRelaySocketFactory(options: { allowPrivate: boolean; lookup?: RelayLookup }): GatewaySocketFactory {
  const dispatcher = guardedRelayAgent(options);
  return (url) => new UndiciWebSocket(url, { dispatcher }) as unknown as GatewaySocket;
}
