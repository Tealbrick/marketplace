import { createHash, randomUUID } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import { nostrEventId, nostrSignatureValid } from "@tealbrick/contract/nostr-approval";

import type { GatewaySocket } from "../discord-gateway.js";
import { HEX64, publicKeyOf, signEvent, verifyAuthTag, verifyEvent, type NostrEvent } from "./nostr.js";

// Test-only: an in-memory fake Buzz relay. Never imported by runtime code. It speaks the relay's HTTP bridge
// (`GET /` NIP-11, `POST /events`, `POST /query`, `PUT /media/upload`) as a `fetch` implementation and the
// NIP-01/NIP-42 WebSocket protocol through an injected socket factory, and it VERIFIES what a real relay
// verifies: NIP-98 (kind 27235, signature, exact `u`, method, payload hash, ±60 s), the NIP-OA tag in `x-auth-tag`
// and in the NIP-42 AUTH event (owner must be a relay member), Blossom upload auth (kind 24242, `t=upload`,
// `x` = body hash, expiration). Nothing here opens a network connection.

export const TEST_RELAY_SECRET = "11".repeat(32);

export type RecordedRelayRequest = { method: string; path: string; headers: Record<string, string>; body: string | null };

type Group = { id: string; name: string; private: boolean; hidden: boolean; owner: string; members: Set<string> };

type Sub = { id: string; filters: Record<string, unknown>[] };

export type FakeRelaySocket = GatewaySocket & {
  url: string;
  sent: unknown[][];
  received: unknown[][];
  closed: number | null;
  challenge: string;
  authed: string | null;
  subs: Map<string, Sub>;
  /** Server-side close (network drop). */
  drop(code?: number): void;
};

function matches(event: NostrEvent, filter: Record<string, unknown>): boolean {
  if (Array.isArray(filter.ids) && !filter.ids.includes(event.id)) return false;
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
  if (Array.isArray(filter.authors) && !filter.authors.includes(event.pubkey)) return false;
  if (typeof filter.since === "number" && event.created_at < filter.since) return false;
  if (typeof filter.until === "number" && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    const name = key.slice(1);
    if (!event.tags.some((tag) => tag[0] === name && values.includes(tag[1]))) return false;
  }
  return true;
}

export function createFakeBuzzRelay(options: { host?: string; members?: string[]; now?: () => number } = {}) {
  const host = options.host ?? "relay.buzz.test";
  const relayUrl = `wss://${host}`;
  const httpBase = `https://${host}`;
  const relayPubkey = publicKeyOf(TEST_RELAY_SECRET)!;
  const now = options.now ?? (() => Date.now());
  const nowSeconds = () => Math.floor(now() / 1000);
  const members = new Set(options.members ?? []);
  const events: NostrEvent[] = [];
  const groups = new Map<string, Group>();
  const requests: RecordedRelayRequest[] = [];
  const sockets: FakeRelaySocket[] = [];
  const seenNonces = new Set<string>();
  const httpOverrides: Array<(request: RecordedRelayRequest) => Response | Error | "hang" | undefined> = [];
  const rejections = new Map<number, string>();
  const uploads: Array<{ sha256: string; type: string; size: number }> = [];

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const relaySigned = (kind: number, tags: string[][], content = "") => signEvent(TEST_RELAY_SECRET, { kind, created_at: nowSeconds(), tags, content });

  const replaceAddressable = (event: NostrEvent) => {
    const d = event.tags.find((tag) => tag[0] === "d")?.[1];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const existing = events[index]!;
      if (existing.kind === event.kind && existing.pubkey === event.pubkey && existing.tags.find((tag) => tag[0] === "d")?.[1] === d) events.splice(index, 1);
    }
    events.push(event);
  };

  const emitGroupState = (group: Group) => {
    replaceAddressable(
      relaySigned(39000, [["d", group.id], ["name", group.name], ["closed"], ...(group.private ? [["private"]] : []), ...(group.hidden ? [["hidden"]] : [])]),
    );
    replaceAddressable(relaySigned(39002, [["d", group.id], ...[...group.members].map((pubkey) => ["p", pubkey])]));
  };

  const broadcast = (event: NostrEvent) => {
    for (const socket of sockets) {
      if (socket.closed !== null || !socket.authed) continue;
      for (const sub of socket.subs.values()) {
        if (sub.filters.some((filter) => matches(event, filter))) deliver(socket, ["EVENT", sub.id, event]);
      }
    }
  };

  const store = (event: NostrEvent) => {
    events.push(event);
    broadcast(event);
  };

  const ownerAllowed = (authTag: unknown, agent: string): boolean => {
    const checked = verifyAuthTag({ tag: authTag, agentPubkey: agent, nowSeconds: nowSeconds() });
    return checked.ok && members.has(checked.value.ownerPubkey);
  };

  /** Ingest one signed event; `{accepted, message}` like the relay bridge. */
  const ingest = (event: NostrEvent): { accepted: boolean; message: string } => {
    const rejection = rejections.get(event.kind);
    if (rejection !== undefined) return { accepted: false, message: rejection };
    const tag = (name: string) => event.tags.find((entry) => entry[0] === name)?.[1];
    const groupId = tag("h");
    switch (event.kind) {
      case 0:
        replaceAddressable({ ...event, tags: [...event.tags, ["d", "profile"]] });
        return { accepted: true, message: "" };
      case 9: {
        const group = groupId ? groups.get(groupId) : undefined;
        if (!group) return { accepted: false, message: "invalid: unknown channel" };
        if (!group.members.has(event.pubkey)) return { accepted: false, message: "restricted: not a channel member" };
        const parent = event.tags.find((entry) => entry[0] === "e" && entry[3] === "reply")?.[1];
        if (parent && !events.some((existing) => existing.id === parent)) return { accepted: false, message: "invalid: unknown parent event" };
        store(event);
        return { accepted: true, message: "" };
      }
      case 7: {
        const target = tag("e");
        if (!target || !events.some((existing) => existing.id === target)) return { accepted: false, message: "invalid: unknown target" };
        store(event);
        return { accepted: true, message: "" };
      }
      case 5: {
        const targets = event.tags.filter((entry) => entry[0] === "e").map((entry) => entry[1]);
        if (targets.length === 0) return { accepted: false, message: "invalid: #e required" };
        // Buzz deletes one target per event.
        if (targets.length > 1) return { accepted: false, message: "invalid: deletion must target exactly one event" };
        for (const target of targets) {
          const existing = events.find((candidate) => candidate.id === target);
          if (existing && existing.pubkey !== event.pubkey) return { accepted: false, message: "restricted: can only delete own events" };
        }
        for (const target of targets) {
          const index = events.findIndex((candidate) => candidate.id === target);
          if (index >= 0) events.splice(index, 1);
        }
        store(event);
        return { accepted: true, message: "" };
      }
      case 40003: {
        const target = events.find((candidate) => candidate.id === tag("e"));
        if (!target || target.pubkey !== event.pubkey) return { accepted: false, message: "restricted: can only edit own messages" };
        store(event);
        return { accepted: true, message: "" };
      }
      case 20002:
        broadcast(event);
        return { accepted: true, message: "" };
      case 9007: {
        if (!groupId || groups.has(groupId)) return { accepted: false, message: "invalid: channel exists" };
        const group: Group = { id: groupId, name: tag("name") ?? "", private: tag("visibility") === "private", hidden: false, owner: event.pubkey, members: new Set([event.pubkey]) };
        groups.set(groupId, group);
        emitGroupState(group);
        store(event);
        return { accepted: true, message: "" };
      }
      case 9000: {
        const group = groupId ? groups.get(groupId) : undefined;
        const target = tag("p");
        if (!group || !target) return { accepted: false, message: "invalid: unknown channel" };
        if (group.private && group.owner !== event.pubkey) return { accepted: false, message: "restricted: owner or admin required" };
        group.members.add(target);
        emitGroupState(group);
        store(event);
        store(relaySigned(44100, [["p", target], ["h", group.id]]));
        return { accepted: true, message: "" };
      }
      case 9001: {
        const group = groupId ? groups.get(groupId) : undefined;
        const target = tag("p");
        if (!group || !target) return { accepted: false, message: "invalid: unknown channel" };
        if (group.owner !== event.pubkey && target !== event.pubkey) return { accepted: false, message: "restricted: owner or admin required" };
        group.members.delete(target);
        emitGroupState(group);
        store(event);
        return { accepted: true, message: "" };
      }
      case 9008: {
        const group = groupId ? groups.get(groupId) : undefined;
        if (!group) return { accepted: false, message: "invalid: unknown channel" };
        if (group.owner !== event.pubkey) return { accepted: false, message: "restricted: owner only" };
        groups.delete(group.id);
        store(event);
        return { accepted: true, message: "" };
      }
      case 41010: {
        const people = event.tags.filter((entry) => entry[0] === "p").map((entry) => entry[1]!);
        if (people.length < 1 || people.length > 8) return { accepted: false, message: "invalid: 1-8 pubkeys" };
        const wanted = new Set([event.pubkey, ...people]);
        const existing = [...groups.values()].find((group) => group.hidden && group.members.size === wanted.size && [...wanted].every((pubkey) => group.members.has(pubkey)));
        const group = existing ?? { id: randomUUID(), name: "", private: true, hidden: true, owner: event.pubkey, members: wanted };
        if (!existing) {
          groups.set(group.id, group);
          emitGroupState(group);
        }
        store(event);
        return { accepted: true, message: `response:${JSON.stringify({ channel_id: group.id, created: !existing })}` };
      }
      default:
        store(event);
        return { accepted: true, message: "" };
    }
  };

  /** NIP-98 as buzz-auth verify_nip98_event checks it, plus replay. Returns the pubkey or an error. */
  const verifyNip98 = (authorization: string | undefined, url: string, method: string, body: string | null): string | { error: string } => {
    if (!authorization?.startsWith("Nostr ")) return { error: "missing Nostr auth" };
    let event: unknown;
    try {
      event = JSON.parse(Buffer.from(authorization.slice(6), "base64").toString("utf8"));
    } catch {
      return { error: "invalid NIP-98 event JSON" };
    }
    if (!verifyEvent(event)) return { error: "NIP-98: invalid Schnorr signature" };
    if (event.kind !== 27235) return { error: "NIP-98: expected kind 27235" };
    if (Math.abs(nowSeconds() - event.created_at) > 60) return { error: "NIP-98: event timestamp outside ±60s window" };
    const u = event.tags.filter((tag) => tag[0] === "u");
    if (u.length !== 1 || u[0]![1] !== url) return { error: "NIP-98: URL mismatch" };
    if (event.tags.find((tag) => tag[0] === "method")?.[1] !== method) return { error: "NIP-98: method mismatch" };
    if (body !== null) {
      const payload = event.tags.find((tag) => tag[0] === "payload")?.[1];
      if (payload !== createHash("sha256").update(body).digest("hex")) return { error: "NIP-98: payload mismatch" };
    }
    if (seenNonces.has(event.id)) return { error: "NIP-98: replay detected" };
    seenNonces.add(event.id);
    return event.pubkey;
  };

  const membership = (pubkey: string, header: string | undefined): string | null => {
    if (members.has(pubkey)) return null;
    if (!header) return "restricted: relay membership required";
    let tag: unknown;
    try {
      tag = JSON.parse(header);
    } catch {
      return "restricted: invalid auth tag";
    }
    return ownerAllowed(tag, pubkey) ? null : "restricted: auth tag not accepted";
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const method = (init?.method ?? "GET").toUpperCase();
    let body: string | null = null;
    let bytes: Buffer | null = null;
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof Blob) bytes = Buffer.from(await init.body.arrayBuffer());
    const request: RecordedRelayRequest = { method, path: url.pathname, headers, body };
    requests.push(request);
    if (url.host !== host) throw new TypeError("fetch failed: unknown host");
    const override = httpOverrides.shift()?.(request);
    if (override === "hang") {
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if (override instanceof Error) throw override;
    if (override) return override;

    if (method === "GET" && url.pathname === "/") {
      return json(200, { name: "fake buzz relay", supported_nips: [1, 11, 29, 42, 98], self: relayPubkey, software: "buzz-test" });
    }
    if (method === "POST" && (url.pathname === "/events" || url.pathname === "/query")) {
      const signer = verifyNip98(headers.authorization, `${httpBase}${url.pathname}`, "POST", body ?? "");
      if (typeof signer !== "string") return json(401, signer);
      const denied = membership(signer, headers["x-auth-tag"]);
      if (denied) return json(403, { error: denied });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? "");
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      if (url.pathname === "/query") {
        if (!Array.isArray(parsed)) return json(400, { error: "invalid filters" });
        const found = events
          .filter((event) => (parsed as Record<string, unknown>[]).some((filter) => matches(event, filter)))
          .sort((a, b) => b.created_at - a.created_at);
        const limit = Math.max(...(parsed as Record<string, unknown>[]).map((filter) => (typeof filter.limit === "number" ? filter.limit : 500)));
        return json(200, found.slice(0, limit));
      }
      if (!verifyEvent(parsed)) return json(400, { error: "invalid: bad event id or signature" });
      if (parsed.pubkey !== signer) return json(403, { error: "restricted: event pubkey must match the authenticated pubkey" });
      const result = ingest(parsed);
      return json(200, { event_id: parsed.id, accepted: result.accepted, message: result.message });
    }
    if (method === "PUT" && url.pathname === "/media/upload") {
      const auth = headers.authorization;
      let event: unknown;
      try {
        event = auth?.startsWith("Nostr ") ? JSON.parse(Buffer.from(auth.slice(6), "base64url").toString("utf8")) : null;
      } catch {
        event = null;
      }
      const sha = bytes ? createHash("sha256").update(bytes).digest("hex") : "";
      if (!verifyEvent(event) || event.kind !== 24242) return json(401, { error: "blossom: invalid auth" });
      const tag = (name: string) => event.tags.find((entry) => entry[0] === name)?.[1];
      if (tag("t") !== "upload" || tag("x") !== sha || Number(tag("expiration")) <= nowSeconds() || tag("server") !== host) return json(401, { error: "blossom: auth does not match" });
      const denied = membership(event.pubkey, headers["x-auth-tag"]);
      if (denied) return json(403, { error: denied });
      const type = headers["content-type"] ?? "application/octet-stream";
      if (type.startsWith("audio/") || type === "application/pdf") return json(415, { error: `disallowed content type: ${type}` });
      uploads.push({ sha256: sha, type, size: bytes!.byteLength });
      const ext = type.split("/")[1] === "jpeg" ? "jpg" : type.split("/")[1];
      return json(200, { url: `${httpBase}/media/${sha}.${ext}`, sha256: sha, size: bytes!.byteLength, type, uploaded: nowSeconds(), dim: "2x2" });
    }
    return json(404, { error: "not found" });
  }) as typeof fetch;

  // ----- WebSocket (NIP-01, NIP-42) -------------------------------------------------

  function deliver(socket: FakeRelaySocket, frame: unknown[]) {
    socket.received.push(frame);
    socket.onmessage?.({ data: JSON.stringify(frame) });
  }

  const onClientFrame = (socket: FakeRelaySocket, frame: unknown[]) => {
    const [type] = frame;
    if (type === "AUTH") {
      const event = frame[1];
      const id = (event as { id?: unknown })?.id;
      if (!verifyEvent(event)) return deliver(socket, ["OK", typeof id === "string" ? id : "", false, "invalid: bad signature"]);
      const tag = (name: string) => event.tags.find((entry) => entry[0] === name)?.[1];
      if (event.kind !== 22242 || tag("relay") !== relayUrl || tag("challenge") !== socket.challenge || Math.abs(nowSeconds() - event.created_at) > 120) {
        return deliver(socket, ["OK", event.id, false, "invalid: auth event does not match"]);
      }
      const auth = event.tags.filter((entry) => entry[0] === "auth");
      if (!members.has(event.pubkey) && (auth.length !== 1 || !ownerAllowed(auth[0], event.pubkey))) {
        return deliver(socket, ["OK", event.id, false, "restricted: owner is not a relay member"]);
      }
      socket.authed = event.pubkey;
      return deliver(socket, ["OK", event.id, true, ""]);
    }
    if (type === "REQ" && typeof frame[1] === "string") {
      const subId = frame[1];
      if (!socket.authed) return deliver(socket, ["CLOSED", subId, "auth-required: authenticate first"]);
      const filters = frame.slice(2) as Record<string, unknown>[];
      for (const filter of filters) {
        const kinds = Array.isArray(filter.kinds) ? (filter.kinds as number[]) : [];
        if (kinds.includes(9) && !Array.isArray(filter["#h"])) return deliver(socket, ["CLOSED", subId, "restricted: channel kinds require #h"]);
        if ((kinds.includes(44100) || kinds.includes(44101)) && (!Array.isArray(filter["#p"]) || (filter["#p"] as string[]).some((value) => value !== socket.authed))) {
          return deliver(socket, ["CLOSED", subId, "restricted: p-gated events require #p matching your pubkey"]);
        }
      }
      socket.subs.set(subId, { id: subId, filters });
      for (const event of events.filter((candidate) => filters.some((filter) => matches(candidate, filter)))) deliver(socket, ["EVENT", subId, event]);
      return deliver(socket, ["EOSE", subId]);
    }
    if (type === "CLOSE" && typeof frame[1] === "string") socket.subs.delete(frame[1]);
  };

  const socketFactory = (url: string): GatewaySocket => {
    const socket: FakeRelaySocket = {
      url,
      sent: [],
      received: [],
      closed: null,
      challenge: randomUUID(),
      authed: null,
      subs: new Map(),
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string) {
        const frame = JSON.parse(data) as unknown[];
        socket.sent.push(frame);
        if (socket.closed === null) onClientFrame(socket, frame);
      },
      close(code?: number) {
        socket.closed = code ?? 1000;
      },
      drop(code = 1006) {
        socket.closed = code;
        socket.onclose?.({ code });
      },
    };
    sockets.push(socket);
    if (url.replace(/\/$/u, "") !== relayUrl) {
      queueMicrotask(() => socket.drop(1006));
    } else {
      queueMicrotask(() => deliver(socket, ["AUTH", socket.challenge]));
    }
    return socket;
  };

  return {
    host,
    relayUrl,
    httpBase,
    relayPubkey,
    events,
    groups,
    requests,
    sockets,
    uploads,
    fetchImpl,
    socketFactory,
    addMember: (pubkey: string) => void members.add(pubkey),
    removeMember: (pubkey: string) => void members.delete(pubkey),
    /** A relay-side channel the given people are members of (the agent joins channels like any member). */
    createGroup(input: { name: string; members: string[]; private?: boolean; hidden?: boolean; owner?: string; id?: string }): string {
      const id = input.id ?? randomUUID();
      const group: Group = { id, name: input.name, private: input.private ?? false, hidden: input.hidden ?? false, owner: input.owner ?? input.members[0]!, members: new Set(input.members) };
      groups.set(id, group);
      emitGroupState(group);
      return id;
    },
    /** Publishes an event signed by another member (inbound tests). */
    inject(secret: string, input: { kind: number; tags: string[][]; content: string; created_at?: number }): NostrEvent {
      const event = signEvent(secret, { kind: input.kind, created_at: input.created_at ?? nowSeconds(), tags: input.tags, content: input.content });
      const group = input.tags.find((tag) => tag[0] === "h")?.[1];
      if (group && groups.get(group)) groups.get(group)!.members.add(event.pubkey);
      if (input.kind === 0) replaceAddressable({ ...event, tags: [...event.tags, ["d", "profile"]] });
      else store(event);
      return event;
    },
    /** Delivers a raw frame to every connected socket (malformed or forged events). */
    pushRaw(subId: string, event: unknown) {
      for (const socket of sockets) if (socket.closed === null) deliver(socket, ["EVENT", subId, event]);
    },
    /** The next HTTP request answers this instead (status errors, hangs, network errors). */
    override(reply: (request: RecordedRelayRequest) => Response | Error | "hang" | undefined) {
      httpOverrides.push(reply);
    },
    rejectKind(kind: number, message: string) {
      rejections.set(kind, message);
    },
    eventsOfKind: (kind: number) => events.filter((event) => event.kind === kind),
    /** True when id and signature verify with the contract helpers (what any Nostr client checks). */
    contractValid: (event: NostrEvent) => nostrEventId(event) === event.id && nostrSignatureValid(event) && HEX64.test(event.pubkey),
  };
}

export type FakeBuzzRelay = ReturnType<typeof createFakeBuzzRelay>;

/** The owner's NIP-OA tag for an agent key, signed with the owner secret (what the owner does on their device). */
export function signAuthTag(ownerSecret: string, agentPubkey: string, conditions: string): [string, string, string, string] {
  const digest = createHash("sha256").update(`nostr:agent-auth:${agentPubkey}:${conditions}`, "utf8").digest();
  const sig = Buffer.from(schnorr.sign(digest, Buffer.from(ownerSecret, "hex"))).toString("hex");
  return ["auth", publicKeyOf(ownerSecret)!, conditions, sig];
}
