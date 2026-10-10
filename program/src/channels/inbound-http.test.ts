import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { createSourceBudget, createSourceResolver, parseTrustedProxies, trustedProxiesWarning } from "./inbound-http.js";

const request = (remoteAddress: string, forwarded?: string) =>
  ({ socket: { remoteAddress }, raw: { socket: { remoteAddress } }, headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded } }) as unknown as FastifyRequest;

describe("inbound source resolution (review F2)", () => {
  it("uses the socket address and ignores X-Forwarded-For without trusted proxies", () => {
    const sourceOf = createSourceResolver(parseTrustedProxies(undefined));
    expect(sourceOf(request("203.0.113.9", "10.0.0.1"))).toBe("203.0.113.9");
    expect(sourceOf(request("::ffff:203.0.113.9"))).toBe("203.0.113.9");
  });

  it("behind a trusted proxy, takes the right-most forwarded entry that is not a trusted proxy", () => {
    const sourceOf = createSourceResolver(parseTrustedProxies("10.0.0.0/8, 192.0.2.1, not-an-ip, fd00::/8"));
    // A client-supplied left part cannot win over the address the proxies appended.
    expect(sourceOf(request("10.1.2.3", "1.1.1.1, 198.51.100.7, 192.0.2.1"))).toBe("198.51.100.7");
    expect(sourceOf(request("192.0.2.1", "198.51.100.8"))).toBe("198.51.100.8");
    expect(sourceOf(request("fd00::5", "2001:db8::9"))).toBe("2001:db8::9");
    // Only proxies in the header: the socket address.
    expect(sourceOf(request("10.1.2.3", "10.9.9.9"))).toBe("10.1.2.3");
    // An untrusted socket never reads the header.
    expect(sourceOf(request("198.51.100.20", "1.2.3.4"))).toBe("198.51.100.20");
    expect(parseTrustedProxies("garbage, 1.2.3.4/99")).toBeNull();
  });

  it("strips ip:port and [v6]:port from forwarded entries before the IP check", () => {
    const sourceOf = createSourceResolver(parseTrustedProxies("10.0.0.0/8, fd00::/8"));
    // A proxy that appends client:port: the client entry wins, not the attacker-chosen entry to its left.
    expect(sourceOf(request("10.1.2.3", "6.6.6.6, 198.51.100.7:51234"))).toBe("198.51.100.7");
    expect(sourceOf(request("10.1.2.3", "6.6.6.6, [2001:db8::9]:443"))).toBe("2001:db8::9");
    expect(sourceOf(request("10.1.2.3", "6.6.6.6, [2001:db8::9]"))).toBe("2001:db8::9");
    expect(sourceOf(request("10.1.2.3", "6.6.6.6, 2001:db8::9"))).toBe("2001:db8::9");
    expect(sourceOf(request("10.1.2.3", "6.6.6.6, 198.51.100.7:51234, 10.9.9.9:80"))).toBe("198.51.100.7");
    expect(sourceOf(request("fd00::5", "6.6.6.6, [fd00::7]:80, [2001:db8::9]:1"))).toBe("2001:db8::9");
    expect(sourceOf(request("10.1.2.3", "6.6.6.6, ::ffff:198.51.100.7"))).toBe("198.51.100.7");
  });

  it("stops the walk at an entry that is not an IP and falls back to the socket address", () => {
    const sourceOf = createSourceResolver(parseTrustedProxies("10.0.0.0/8"));
    for (const garbage of ["unknown", "198.51.100.7:99999999", "198.51.100.7:", "[198.51.100.7", "999.1.1.1", "1.2.3.4:5:6", "_hidden", ""]) {
      expect(sourceOf(request("10.1.2.3", `6.6.6.6, ${garbage}`)), garbage).toBe("10.1.2.3");
      // A trusted hop to the right of the garbage does not skip it.
      expect(sourceOf(request("10.1.2.3", `6.6.6.6, ${garbage}, 10.9.9.9`)), garbage).toBe("10.1.2.3");
    }
    expect(sourceOf(request("10.1.2.3", "6.6.6.6, , 198.51.100.7"))).toBe("198.51.100.7");
  });

  it("evicts the least recently seen source instead of resetting every bucket", () => {
    let now = 0;
    const budget = createSourceBudget({ capacity: 1, refillPerSecond: 0 }, () => now, 3);
    expect(budget.take("a")).toBe(true);
    expect(budget.take("a")).toBe(false);
    for (const source of ["b", "c", "d"]) expect(budget.take(source)).toBe(true);
    // "a" was the oldest: evicted; "b" stays limited (no global clear).
    expect(budget.size).toBe(3);
    expect(budget.take("b")).toBe(false);
    expect(budget.take("d")).toBe(false);
    now += 1;
  });
});

describe("trusted proxies startup warning", () => {
  const none = { slack: false, telegram: false, teams: false };

  it("warns, naming the receivers and the variable only, when a receiver is configured and no proxy is trusted", () => {
    const warning = trustedProxiesWarning(parseTrustedProxies(undefined), { slack: true, telegram: false, teams: true });
    expect(warning).toMatchObject({ event: "marketplace.channels.inbound_trusted_proxies_unset", receivers: ["slack", "teams"], env: "MARKETPLACE_TRUSTED_PROXIES" });
    expect(trustedProxiesWarning(parseTrustedProxies("not-an-ip"), { ...none, telegram: true })?.receivers).toEqual(["telegram"]);
  });

  it("stays quiet with trusted proxies or without any configured receiver", () => {
    expect(trustedProxiesWarning(parseTrustedProxies("100.64.0.0/10"), { slack: true, telegram: true, teams: true })).toBeNull();
    expect(trustedProxiesWarning(null, none)).toBeNull();
  });
});
