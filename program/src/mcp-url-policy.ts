import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound URL policy for operator-configured remote MCP servers.
 *
 * - `https:` only, no userinfo, no fragment, no query string (query strings
 *   often carry API keys and the URL is stored in the listing manifest; keys
 *   belong in secret headers).
 * - Hostnames `localhost`, `*.localhost`, `*.local`, `*.internal` are refused.
 * - IP literals and every DNS answer must be public: loopback, RFC1918,
 *   link-local (incl. cloud metadata 169.254.169.254), ULA fc00::/7,
 *   unspecified, multicast, and reserved ranges are refused.
 * - CGNAT 100.64.0.0/10 is allowed: Tailscale tailnet endpoints (*.ts.net)
 *   are the preferred way to reach private MCP servers.
 * - `MARKETPLACE_MCP_ALLOWED_ORIGINS` (comma list of exact origins, http
 *   allowed) bypasses the checks for fixtures and tests.
 */

export type McpUrlPolicyReason =
  | "invalid_url"
  | "scheme_not_https"
  | "userinfo_not_allowed"
  | "fragment_not_allowed"
  | "query_not_allowed"
  | "hostname_not_allowed"
  | "address_not_allowed"
  | "dns_lookup_failed";

export class McpUrlPolicyError extends Error {
  readonly code = "custom_mcp_url_not_allowed";
  constructor(readonly reason: McpUrlPolicyReason) {
    super(`MCP server URL is not allowed (${reason}).`);
  }
}

export type McpLookup = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export const defaultMcpLookup: McpLookup = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

type Env = Record<string, string | undefined>;

export function configuredMcpAllowedOrigins(env: Env = process.env) {
  return new Set(
    (env.MARKETPLACE_MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function forbiddenIpv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // "this network" / unspecified
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0 && octets[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  // 100.64.0.0/10 (CGNAT / Tailscale) is deliberately allowed.
  return false;
}

function expandIpv6(address: string): number[] | null {
  let value = address.toLowerCase();
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  let tail: number[] = [];
  const lastColon = value.lastIndexOf(":");
  const maybeV4 = value.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const octets = ipv4Octets(maybeV4);
    if (!octets) return null;
    tail = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    value = `${value.slice(0, lastColon + 1)}0:0`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part ? part.split(":").map((group) => (/^[0-9a-f]{1,4}$/u.test(group) ? parseInt(group, 16) : NaN)) : [];
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill(0), ...rest];
  if (groups.length !== 8 || groups.some((group) => Number.isNaN(group))) return null;
  if (tail.length) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

function forbiddenIpv6(groups: number[]): boolean {
  const [g0, , , , , g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  if (groups.every((group) => group === 0)) return true; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && groups[1] === 0x0db8) return true; // documentation
  const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (groups.slice(0, 5).every((group) => group === 0) && (g5 === 0xffff || g5 === 0)) {
    return forbiddenIpv4(embedded);
  }
  // NAT64 64:ff9b::/96
  if (g0 === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return forbiddenIpv4(embedded);
  }
  return false;
}

/** True when `address` (IPv4 or IPv6 literal) must never be contacted. */
export function isForbiddenMcpAddress(address: string): boolean {
  const family = isIP(address.replace(/^\[|\]$/gu, "").split("%")[0] ?? "");
  const bare = address.replace(/^\[|\]$/gu, "");
  if (family === 4) {
    const octets = ipv4Octets(bare);
    return !octets || forbiddenIpv4(octets);
  }
  if (family === 6) {
    const groups = expandIpv6(bare);
    return !groups || forbiddenIpv6(groups);
  }
  return true;
}

function forbiddenHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "" ||
    // Single-label names resolve through local search domains.
    (!host.includes(".") && isIP(host) === 0)
  );
}

export type McpUrlCheck = { url: URL; allowlisted: boolean };

/** Synchronous checks that do not need DNS. Throws McpUrlPolicyError. */
export function checkMcpUrlSyntax(value: string, env: Env = process.env): McpUrlCheck {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpUrlPolicyError("invalid_url");
  }
  if (configuredMcpAllowedOrigins(env).has(url.origin)) {
    if (url.username || url.password) throw new McpUrlPolicyError("userinfo_not_allowed");
    return { url, allowlisted: true };
  }
  if (url.protocol !== "https:") throw new McpUrlPolicyError("scheme_not_https");
  if (url.username || url.password) throw new McpUrlPolicyError("userinfo_not_allowed");
  if (url.hash) throw new McpUrlPolicyError("fragment_not_allowed");
  if (url.search) throw new McpUrlPolicyError("query_not_allowed");
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(hostname)) {
    if (isForbiddenMcpAddress(hostname)) throw new McpUrlPolicyError("address_not_allowed");
    return { url, allowlisted: false };
  }
  if (forbiddenHostname(hostname)) throw new McpUrlPolicyError("hostname_not_allowed");
  return { url, allowlisted: false };
}

/**
 * Full check run before every outbound connection: syntax plus a fresh DNS
 * resolution where every answer must be a public address.
 */
export async function assertMcpUrlAllowed(
  value: string,
  options: { env?: Env; lookup?: McpLookup } = {},
): Promise<URL> {
  const { url, allowlisted } = checkMcpUrlSyntax(value, options.env);
  if (allowlisted) return url;
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(hostname)) return url;
  let answers: ReadonlyArray<{ address: string }>;
  try {
    answers = await (options.lookup ?? defaultMcpLookup)(hostname);
  } catch {
    throw new McpUrlPolicyError("dns_lookup_failed");
  }
  if (answers.length === 0) throw new McpUrlPolicyError("dns_lookup_failed");
  if (answers.some((answer) => isForbiddenMcpAddress(answer.address))) {
    throw new McpUrlPolicyError("address_not_allowed");
  }
  return url;
}
