import { describe, expect, it } from "vitest";

import { DISCORD_GATEWAY_URL, DISCORD_INTENTS, createDiscordGateway, discordIntents, type GatewaySocket, type Timers } from "./discord-gateway.js";
import type { InboundMessage } from "./providers/types.js";

const TOKEN = "MTSentinelDISCORDtoken.Gx1234.abcdefghijklmnopqrstuvwxyz0123";

/** A deterministic timer queue. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const queue = new Map<number, { at: number; callback: () => void }>();
  const timers: Timers = {
    setTimeout: (callback, ms) => {
      const id = next++;
      queue.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => void queue.delete(handle as number),
  };
  return {
    timers,
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
    pending: () => queue.size,
  };
}

type FakeSocket = GatewaySocket & { url: string; sent: Array<Record<string, unknown>>; closed: number | null; receive(payload: unknown): void; serverClose(code: number): void };

function fakeSockets() {
  const sockets: FakeSocket[] = [];
  const factory = (url: string): GatewaySocket => {
    const socket: FakeSocket = {
      url,
      sent: [],
      closed: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string) {
        socket.sent.push(JSON.parse(data) as Record<string, unknown>);
      },
      close(code?: number) {
        socket.closed = code ?? 1000;
      },
      receive(payload: unknown) {
        socket.onmessage?.({ data: JSON.stringify(payload) });
      },
      serverClose(code: number) {
        socket.closed = code;
        socket.onclose?.({ code });
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets, last: () => sockets[sockets.length - 1]! };
}

function setup(input: { messageContent?: boolean; leaseFree?: () => boolean } = {}) {
  const clock = fakeTimers();
  const net = fakeSockets();
  const messages: InboundMessage[] = [];
  const statuses: string[] = [];
  let leaseHeld = false;
  let releases = 0;
  const gateway = createDiscordGateway({
    token: TOKEN,
    messageContent: input.messageContent ?? false,
    lease: {
      acquire: () => (leaseHeld = input.leaseFree ? input.leaseFree() : true),
      release: () => void (releases += 1),
    },
    onMessage: (message) => messages.push(message),
    onStatus: (status, detail) => statuses.push(detail ? `${status}:${detail}` : status),
    socketFactory: net.factory,
    timers: clock.timers,
    random: () => 0.5,
    leaseRenewMs: 20_000,
  });
  return { gateway, clock, net, messages, statuses, lease: () => leaseHeld, releases: () => releases };
}

const hello = { op: 10, d: { heartbeat_interval: 40_000 }, s: null, t: null };
const ready = (seq = 1) => ({ op: 0, t: "READY", s: seq, d: { session_id: "sess-1", resume_gateway_url: "wss://gateway-us-east1-b.discord.gg", user: { id: "4242", bot: true } } });
const messageCreate = (seq: number, over: Record<string, unknown> = {}) => ({
  op: 0,
  t: "MESSAGE_CREATE",
  s: seq,
  d: { id: `90000000000000${seq}`, channel_id: "5550001", guild_id: "777", author: { id: "1234567890123", username: "ada" }, content: "hi bot", type: 0, ...over },
});

describe("Discord gateway client", () => {
  it("identifies with GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES (no privileged intent by default) and heartbeats", () => {
    const t = setup();
    t.gateway.start();
    const socket = t.net.last();
    expect(socket.url).toBe(DISCORD_GATEWAY_URL);
    socket.receive(hello);
    expect(socket.sent[0]).toEqual({
      op: 2,
      d: { token: TOKEN, intents: DISCORD_INTENTS.GUILDS | DISCORD_INTENTS.GUILD_MESSAGES | DISCORD_INTENTS.DIRECT_MESSAGES, properties: { os: "linux", browser: "tealbrick-marketplace", device: "tealbrick-marketplace" } },
    });
    expect(discordIntents(false) & DISCORD_INTENTS.MESSAGE_CONTENT).toBe(0);
    socket.receive(ready());
    expect(t.gateway.status).toBe("ready");
    expect(t.gateway.botUserId).toBe("4242");
    // First beat after interval × jitter (0.5), then every interval, carrying the last sequence.
    t.clock.advance(20_000);
    expect(socket.sent[1]).toEqual({ op: 1, d: 1 });
    socket.receive({ op: 11 });
    t.clock.advance(40_000);
    expect(socket.sent[2]).toEqual({ op: 1, d: 1 });
    // Discord may ask for a beat at once (op 1).
    socket.receive({ op: 1 });
    expect(socket.sent[3]).toEqual({ op: 1, d: 1 });
  });

  it("adds MESSAGE_CONTENT only when the owner enables it", () => {
    const t = setup({ messageContent: true });
    t.gateway.start();
    t.net.last().receive(hello);
    expect((t.net.last().sent[0]!.d as { intents: number }).intents & DISCORD_INTENTS.MESSAGE_CONTENT).toBe(DISCORD_INTENTS.MESSAGE_CONTENT);
  });

  it("hands MESSAGE_CREATE to the pipeline, ignoring its own and other bots' messages", () => {
    const t = setup();
    t.gateway.start();
    const socket = t.net.last();
    socket.receive(hello);
    socket.receive(ready());
    socket.receive(messageCreate(2));
    socket.receive(messageCreate(3, { author: { id: "4242", username: "me", bot: true } }));
    socket.receive(messageCreate(4, { author: { id: "5555555555555", username: "other", bot: true } }));
    socket.receive({ op: 0, t: "GUILD_CREATE", s: 5, d: { id: "777" } });
    expect(t.messages).toEqual([
      { platform: "discord", channelId: "5550001", messageId: "900000000000002", senderUserId: "1234567890123", senderDisplay: "ada", text: "hi bot", attachments: [] },
    ]);
  });

  it("treats a missing heartbeat ACK as a zombie and RESUMEs on the resume URL with the last sequence", () => {
    const t = setup();
    t.gateway.start();
    const first = t.net.last();
    first.receive(hello);
    first.receive(ready(7));
    t.clock.advance(20_000); // beat 1 (no ACK follows)
    t.clock.advance(40_000); // beat 2 is due: no ACK since beat 1 → reconnect
    expect(first.closed).toBe(4000);
    const second = t.net.last();
    expect(second).not.toBe(first);
    expect(second.url).toBe("wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json");
    second.receive(hello);
    expect(second.sent[0]).toEqual({ op: 6, d: { token: TOKEN, session_id: "sess-1", seq: 7 } });
    second.receive({ op: 0, t: "RESUMED", s: 8, d: {} });
    expect(t.gateway.status).toBe("ready");
  });

  it("resumes on RECONNECT (op 7) and identifies again after a non-resumable INVALID SESSION", () => {
    const t = setup();
    t.gateway.start();
    const first = t.net.last();
    first.receive(hello);
    first.receive(ready(3));
    first.receive({ op: 7, d: null });
    const second = t.net.last();
    second.receive(hello);
    expect(second.sent[0]).toMatchObject({ op: 6 });
    second.receive({ op: 9, d: false });
    expect(t.net.sockets).toHaveLength(2);
    t.clock.advance(3_000); // 1 s + 0.5 × 4 s
    const third = t.net.last();
    expect(third.url).toBe(DISCORD_GATEWAY_URL);
    third.receive(hello);
    expect(third.sent[0]).toMatchObject({ op: 2 });
  });

  it("reconnects with backoff after a dropped connection and stops for good on authentication failure", () => {
    const t = setup();
    t.gateway.start();
    const first = t.net.last();
    first.receive(hello);
    first.receive(ready());
    first.serverClose(1006);
    expect(t.gateway.status).toBe("backoff");
    t.clock.advance(749);
    expect(t.net.sockets).toHaveLength(1);
    t.clock.advance(1); // 1000 × (0.5 + 0.5 × 0.5) = 750 ms
    const second = t.net.last();
    expect(second).not.toBe(first);
    second.receive(hello);
    expect(second.sent[0]).toMatchObject({ op: 6 });
    second.serverClose(4004);
    expect(t.gateway.status).toBe("failed");
    expect(t.statuses).toContain("failed:authentication_failed");
    expect(t.releases()).toBe(1);
    t.clock.advance(600_000);
    expect(t.net.sockets).toHaveLength(2);
  });

  it("drops the session after close 4009 and stops on disallowed intents (4014)", () => {
    const t = setup({ messageContent: true });
    t.gateway.start();
    t.net.last().receive(hello);
    t.net.last().receive(ready());
    t.net.last().serverClose(4009);
    t.clock.advance(1_000);
    t.net.last().receive(hello);
    expect(t.net.last().sent[0]).toMatchObject({ op: 2 });
    t.net.last().serverClose(4014);
    expect(t.gateway.status).toBe("failed");
    expect(t.gateway.detail).toBe("disallowed_intents");
  });

  it("connects only while it holds the consumer lease, waits while another instance holds it, and disconnects when it loses it", () => {
    let free = false;
    const t = setup({ leaseFree: () => free });
    t.gateway.start();
    expect(t.net.sockets).toHaveLength(0);
    expect(t.gateway.status).toBe("waiting_lease");
    expect(t.gateway.detail).toBe("consumer_conflict");
    free = true;
    t.clock.advance(20_000);
    expect(t.net.sockets).toHaveLength(1);
    t.net.last().receive(hello);
    t.net.last().receive(ready());
    // Renewal keeps the connection.
    t.clock.advance(20_000);
    expect(t.net.sockets).toHaveLength(1);
    expect(t.net.last().closed).toBeNull();
    // Lost lease: disconnect and wait.
    free = false;
    t.clock.advance(20_000);
    expect(t.net.last().closed).toBe(1000);
    expect(t.gateway.status).toBe("waiting_lease");
    t.gateway.stop();
    expect(t.gateway.status).toBe("stopped");
    expect(t.clock.pending()).toBe(0);
  });

  it("never puts the token in a status or detail", () => {
    const t = setup();
    t.gateway.start();
    t.net.last().serverClose(4004);
    expect(JSON.stringify(t.statuses)).not.toContain(TOKEN);
    expect(String(t.gateway.detail)).not.toContain(TOKEN);
  });
});
