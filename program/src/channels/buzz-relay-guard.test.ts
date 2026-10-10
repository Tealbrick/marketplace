import { describe, expect, it } from "vitest";

import { buzzPrivateRelayAllowed, checkRelayHost, embeddedIpv4, guardedLookup, guardedRelayFetch, isBlockedRelayAddress, isBlockedRelayHostname, type RelayLookup } from "./buzz-relay-guard.js";
import { normalizeRelayUrl } from "./providers/buzz.js";

const PUBLIC_V4 = "104.16.132.229";
const PUBLIC_V6 = "2606:4700::6810:84e5";
const lookupOf = (answers: Record<string, string[]>): RelayLookup => async (hostname) => (answers[hostname] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("buzz relay egress guard", () => {
  it("blocks every non-public address class (and their IPv4-mapped / NAT64 forms)", () => {
    const blocked = {
      loopback: ["127.0.0.1", "127.255.0.9", "::1"],
      unspecified: ["0.0.0.0", "::"],
      rfc1918: ["10.0.0.5", "172.16.3.4", "172.31.255.1", "192.168.1.1"],
      ula: ["fc00::1", "fd12:3456::1"],
      linkLocal: ["169.254.10.10", "fe80::1"],
      metadata: ["169.254.169.254", "fd00:ec2::254"],
      cgnat: ["100.64.0.1", "100.127.255.254", "::ffff:100.64.0.1"],
      mapped: ["::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe"],
      multicast: ["224.0.0.1", "ff02::1"],
    };
    for (const [kind, addresses] of Object.entries(blocked)) {
      for (const address of addresses) expect(isBlockedRelayAddress(address), `${kind} ${address}`).toBe(true);
    }
    for (const address of [PUBLIC_V4, PUBLIC_V6, "100.63.255.255", "100.128.0.1", "172.32.0.1"]) expect(isBlockedRelayAddress(address), address).toBe(false);
    for (const name of ["localhost", "relay.localhost", "printer.local", "metadata.google.internal", "metadata", "anything.internal", "router.home.arpa", "intranet", "127.0.0.1", "[::1]"]) {
      expect(isBlockedRelayHostname(name), name).toBe(true);
    }
    expect(isBlockedRelayHostname("martinatrin.up.railway.app")).toBe(false);
  });

  it("applies every IPv4 rule to IPv4 carried in IPv6, in hex and dotted notation (mapped, compatible, NAT64, 6to4, Teredo)", () => {
    // Teredo client 100.64.0.1 → inverted 9bbf:fffe; 6to4 of 10.0.0.1 → 2002:0a00:0001::.
    const embedded: Array<[string, string]> = [
      ["::ffff:100.64.0.1", "100.64.0.1"],
      ["::ffff:6440:1", "100.64.0.1"],
      ["[::ffff:6440:1]", "100.64.0.1"],
      ["::ffff:a9fe:a9fe", "169.254.169.254"],
      ["::6440:1", "100.64.0.1"],
      ["::10.0.0.1", "10.0.0.1"],
      ["64:ff9b::6440:1", "100.64.0.1"],
      ["64:ff9b::127.0.0.1", "127.0.0.1"],
      ["64:ff9b:1::a00:1", "10.0.0.1"],
      ["64:ff9b:1:abcd::c0a8:101", "192.168.1.1"],
      ["2002:a00:1::1", "10.0.0.1"],
      ["2002:6440:1::", "100.64.0.1"],
      ["2002:a9fe:a9fe::1", "169.254.169.254"],
      ["2001:0:4136:e378:8000:63bf:9bbf:fffe", "100.64.0.1"],
      ["2001:0:4136:e378:8000:63bf:f5ff:fffe", "10.0.0.1"],
    ];
    for (const [address, ipv4] of embedded) {
      expect(embeddedIpv4(address), address).toBe(ipv4);
      expect(isBlockedRelayAddress(address), address).toBe(true);
    }
    // The same forms carrying a public IPv4 stay allowed.
    for (const address of ["::ffff:6810:84e5", "64:ff9b::6810:84e5", "2002:6810:84e5::1", "2001:0:4136:e378:8000:63bf:97ef:7b1a"]) {
      expect(isBlockedRelayAddress(address), address).toBe(false);
    }
    expect(embeddedIpv4(PUBLIC_V6)).toBeNull();
    expect(normalizeRelayUrl("wss://[::ffff:100.64.0.1]")?.host).toBe("[::ffff:6440:1]");
  });

  it("checks every resolved address: a name resolving to a private IP, or mixed A/AAAA records, is refused", async () => {
    const lookup = lookupOf({
      "public.relay.example": [PUBLIC_V4, PUBLIC_V6],
      "private.relay.example": ["10.1.2.3"],
      "mixed.relay.example": [PUBLIC_V4, "192.168.0.10"],
      "mixed6.relay.example": [PUBLIC_V4, "fd00:ec2::254"],
      "metadata.relay.example": ["169.254.169.254"],
    });
    expect(await checkRelayHost("public.relay.example", { allowPrivate: false, lookup })).toEqual({ ok: true, addresses: [PUBLIC_V4, PUBLIC_V6] });
    for (const host of ["private.relay.example", "mixed.relay.example", "mixed6.relay.example", "metadata.relay.example"]) {
      expect(await checkRelayHost(host, { allowPrivate: false, lookup }), host).toEqual({ ok: false, reason: "relay_address_blocked" });
    }
    expect(await checkRelayHost("unknown.relay.example", { allowPrivate: false, lookup })).toEqual({ ok: false, reason: "relay_dns_failed" });
    // IP-literal hosts get the same checks.
    expect(await checkRelayHost("10.0.0.1", { allowPrivate: false, lookup })).toEqual({ ok: false, reason: "relay_host_blocked" });
    expect(await checkRelayHost(`[${PUBLIC_V6}]`, { allowPrivate: false, lookup })).toEqual({ ok: true, addresses: [PUBLIC_V6] });
    expect(normalizeRelayUrl(`wss://[${PUBLIC_V6}]`)?.relayUrl).toBe(`wss://[${PUBLIC_V6}]`);
    expect(normalizeRelayUrl("ws://public.relay.example")).toBeNull();
  });

  it("re-resolves at every connect and pins the connection to a checked address (a DNS change cannot bypass it)", async () => {
    let answers = [PUBLIC_V4];
    let lookups = 0;
    const lookup: RelayLookup = async () => {
      lookups += 1;
      return answers.map((address) => ({ address, family: 4 }));
    };
    const connectLookup = guardedLookup({ allowPrivate: false, lookup });
    const resolve = () =>
      new Promise<{ error: NodeJS.ErrnoException | null; address: unknown }>((done) => connectLookup("relay.example.org", { all: false }, (error, address) => done({ error, address })));
    expect(await resolve()).toEqual({ error: null, address: PUBLIC_V4 });
    // The name now points at the metadata service: the next connection is refused before any socket opens.
    answers = ["169.254.169.254"];
    const rebound = await resolve();
    expect(rebound.error?.message).toBe("relay_address_blocked");
    answers = [PUBLIC_V4, "127.0.0.1"];
    expect((await resolve()).error?.message).toBe("relay_address_blocked");
    expect(lookups).toBe(3);
    const all = await new Promise<unknown>((done) => connectLookup("relay.example.org", { all: true }, (_error, address) => done(address)));
    expect(all).toBe("");
  });

  it("the adapter's default fetch goes through the guarded agent: a name resolving to a private address never connects", async () => {
    const lookup = lookupOf({ "rebound.relay.example": ["127.0.0.1"] });
    const fetchImpl = guardedRelayFetch({ allowPrivate: false, lookup });
    const failure = await fetchImpl("https://rebound.relay.example/query", { method: "POST", body: "[]" }).then(
      () => null,
      (error: unknown) => error as Error & { cause?: { message?: string } },
    );
    expect(failure).not.toBeNull();
    expect(String(failure?.cause?.message ?? failure?.message)).toContain("relay_address_blocked");
  });

  it("allows private relays only behind the dev flag, never in production", async () => {
    expect(buzzPrivateRelayAllowed({})).toBe(false);
    // NODE_ENV unset (or anything but development/test): the flag is off.
    expect(buzzPrivateRelayAllowed({ MARKETPLACE_CHANNELS_BUZZ_ALLOW_PRIVATE_RELAY: "1" })).toBe(false);
    expect(buzzPrivateRelayAllowed({ MARKETPLACE_CHANNELS_BUZZ_ALLOW_PRIVATE_RELAY: "1", NODE_ENV: "staging" })).toBe(false);
    expect(buzzPrivateRelayAllowed({ MARKETPLACE_CHANNELS_BUZZ_ALLOW_PRIVATE_RELAY: "1", NODE_ENV: "test" })).toBe(true);
    expect(buzzPrivateRelayAllowed({ MARKETPLACE_CHANNELS_BUZZ_ALLOW_PRIVATE_RELAY: "true", NODE_ENV: "development" })).toBe(true);
    expect(buzzPrivateRelayAllowed({ MARKETPLACE_CHANNELS_BUZZ_ALLOW_PRIVATE_RELAY: "1", NODE_ENV: "production" })).toBe(false);
    expect(buzzPrivateRelayAllowed({ MARKETPLACE_CHANNELS_BUZZ_ALLOW_PRIVATE_RELAY: "0" })).toBe(false);
    const lookup = lookupOf({ localhost: ["127.0.0.1"] });
    expect(await checkRelayHost("localhost", { allowPrivate: true, lookup })).toEqual({ ok: true, addresses: ["127.0.0.1"] });
    expect(await checkRelayHost("localhost", { allowPrivate: false, lookup })).toEqual({ ok: false, reason: "relay_host_blocked" });
  });
});
