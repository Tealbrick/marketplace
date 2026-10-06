/**
 * Tailnet reachability for outbound connector traffic.
 *
 * Off by default. The Railway image entrypoint starts a userspace
 * `tailscaled` only when `TS_AUTHKEY` is set, and then hands the app:
 * - `MARKETPLACE_TAILNET_PROXY=http://127.0.0.1:1055` (tailscaled's
 *   outbound HTTP proxy) when the node came up, or
 * - `MARKETPLACE_TAILNET_STATE=unavailable` when it did not.
 *
 * With a proxy configured, requests to `*.ts.net` hosts and 100.64.0.0/10
 * addresses go through it (HTTPS via CONNECT; TLS is verified end to end by
 * the client as usual). Everything else stays direct. Without either
 * variable nothing changes. The auth key never reaches this process.
 */
import { connect } from "node:net";

import { fetch as undiciFetch, ProxyAgent } from "undici";

type Env = Record<string, string | undefined>;

export type TailnetMode = "disabled" | "proxy" | "unavailable";
export type TailnetHealth = "disabled" | "connected" | "unavailable";

export class TailnetUnavailableError extends Error {
  readonly code = "tailnet_unavailable";
  constructor() {
    super("The tailnet is not reachable from Marketplace right now.");
  }
}

function ipv4Octets(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/u.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** 100.64.0.0/10: Tailscale node addresses (CGNAT range). */
export function isTailnetAddress(value: string) {
  const octets = ipv4Octets(value);
  return octets !== null && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

/** `<host>.<tailnet>.ts.net` MagicDNS names. */
export function isTailnetHostname(value: string) {
  const host = value.toLowerCase().replace(/\.$/u, "");
  return host.endsWith(".ts.net") && host.length > ".ts.net".length;
}

export function isTailnetHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/gu, "");
  return isTailnetHostname(host) || isTailnetAddress(host);
}

/** The proxy must be a loopback `http://` URL (tailscaled's local listener). */
function loopbackProxy(value: string | undefined) {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "http:" || !loopback || url.username || url.password || !url.port) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function tailnetConfig(env: Env = process.env): { mode: TailnetMode; proxyUrl: string | null } {
  const proxyUrl = loopbackProxy(env.MARKETPLACE_TAILNET_PROXY);
  if (proxyUrl) return { mode: "proxy", proxyUrl };
  if (env.MARKETPLACE_TAILNET_PROXY?.trim() || env.MARKETPLACE_TAILNET_STATE === "unavailable") {
    return { mode: "unavailable", proxyUrl: null };
  }
  return { mode: "disabled", proxyUrl: null };
}

export type OutboundRoute = { kind: "direct" } | { kind: "proxy"; proxyUrl: string };

/**
 * Route one outbound URL. Tailnet hosts use the proxy when it exists and fail
 * with `tailnet_unavailable` when the tailnet was configured but is down;
 * with the tailnet disabled they go direct exactly as before. The URL policy
 * (https only, no private ranges) is enforced separately and first.
 */
export function routeOutbound(url: URL, env: Env = process.env): OutboundRoute {
  if (!isTailnetHost(url.hostname)) return { kind: "direct" };
  const config = tailnetConfig(env);
  if (config.mode === "proxy") return { kind: "proxy", proxyUrl: config.proxyUrl! };
  if (config.mode === "unavailable") throw new TailnetUnavailableError();
  return { kind: "direct" };
}

/** True when the URL policy may skip local DNS: MagicDNS names resolve inside tailscaled. */
export function tailnetResolvesHostname(hostname: string, env: Env = process.env) {
  return isTailnetHostname(hostname) && tailnetConfig(env).mode === "proxy";
}

const agents = new Map<string, ProxyAgent>();

function proxyAgent(proxyUrl: string) {
  let agent = agents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent({ uri: proxyUrl });
    agents.set(proxyUrl, agent);
  }
  return agent;
}

/**
 * A fetch that sends tailnet hosts through the tailnet proxy and everything
 * else through `fetchImpl` (default: global fetch). Throws
 * TailnetUnavailableError for tailnet hosts when the tailnet is down.
 */
export function tailnetAwareFetch(env: Env = process.env, fetchImpl?: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = routeOutbound(url, env);
    if (route.kind === "direct") return (fetchImpl ?? fetch)(input, init);
    let body = init?.body;
    const headers = new Headers(init?.headers);
    if (body instanceof FormData) {
      // Serialize multipart here: the proxied fetch is undici's own, and its
      // FormData class differs from the global one.
      const encoded = new Response(body);
      headers.set("content-type", encoded.headers.get("content-type")!);
      body = new Uint8Array(await encoded.arrayBuffer());
    }
    return (await undiciFetch(url, {
      ...(init as Record<string, unknown>),
      headers: Object.fromEntries(headers),
      ...(body === undefined || body === null ? {} : { body }),
      dispatcher: proxyAgent(route.proxyUrl),
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  }) as typeof fetch;
}

let healthCache: { key: string; at: number; value: TailnetHealth } | null = null;

/** Probe tailscaled's local proxy listener (TCP connect only). */
function proxyListening(proxyUrl: string, timeoutMs: number) {
  const url = new URL(proxyUrl);
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/gu, ""), port: Number(url.port) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** `disabled` | `connected` | `unavailable`. No addresses, names or keys. */
export async function tailnetHealth(env: Env = process.env, options: { cacheMs?: number; timeoutMs?: number } = {}) {
  const config = tailnetConfig(env);
  if (config.mode === "disabled") return "disabled" as const;
  if (config.mode === "unavailable") return "unavailable" as const;
  const now = Date.now();
  if (healthCache && healthCache.key === config.proxyUrl && now - healthCache.at < (options.cacheMs ?? 5_000)) {
    return healthCache.value;
  }
  const value: TailnetHealth = (await proxyListening(config.proxyUrl!, options.timeoutMs ?? 500))
    ? "connected"
    : "unavailable";
  healthCache = { key: config.proxyUrl!, at: now, value };
  return value;
}
