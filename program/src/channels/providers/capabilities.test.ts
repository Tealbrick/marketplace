import { describe, expect, it } from "vitest";
import { AGENT_WIRED_FEATURES, CHANNEL_FEATURES, capabilitySupports, featureRefusal, wiredCapabilities } from "./capabilities.js";
import { createDiscordProvider } from "./discord.js";
import { createTelegramProvider } from "./telegram.js";
import { CHANNEL_CAPABILITIES_VERSION, type ChannelCapabilities } from "./types.js";

const telegram = createTelegramProvider().capabilities;
const discord = createDiscordProvider().capabilities;

const RICH: ChannelCapabilities = {
  ...telegram,
  dm: { open: true, maxMembers: 8 },
  thread: { replies: true, topics: false, forum: true },
  mentions: { users: true, broadcast: "suppressed" },
  reactions: { add: true, remove: false, custom: true },
  edit: { own: true, windowSeconds: 900 },
  delete: { own: true },
  canvas: true,
  presence: { typing: true, status: false },
  ephemeral: true,
  live: { join: true, listen: true, speak: false, transcript: true, maxSessionMinutes: 120 },
  inbound: { mode: "socket", dedupe: true },
  poll: true,
};

describe("capability model v2", () => {
  it("is version 2 and every provider declares that version with all v2 keys", () => {
    expect(CHANNEL_CAPABILITIES_VERSION).toBe(2);
    for (const caps of [telegram, discord]) {
      expect(caps.channelCapabilities).toBe(2);
      for (const key of ["dm", "thread", "mentions", "reactions", "edit", "delete", "canvas", "presence", "ephemeral", "live", "inbound"]) {
        expect(caps, key).toHaveProperty(key);
      }
      expect(caps.mentions.broadcast).toBe("suppressed");
    }
  });

  it("declares only what the adapters do today: P2 features are false or none", () => {
    for (const caps of [telegram, discord]) {
      for (const feature of CHANNEL_FEATURES) {
        if (["image", "file", "audio", "voice", "video"].includes(feature)) continue;
        if (feature === "thread.topics" && caps === telegram) continue; // forum topics are a Phase 1 destination type
        expect(capabilitySupports(caps, feature), feature).toBe(false);
      }
      expect(caps.live).toBe(false);
      expect(caps.inbound).toEqual({ mode: "none", dedupe: false });
    }
    expect(telegram.thread).toEqual({ replies: false, topics: true, forum: false });
    expect(discord.thread).toEqual({ replies: false, topics: false, forum: false });
  });
});

describe("capabilitySupports", () => {
  it("answers attachment kinds from the declaration, a voice fallback included", () => {
    expect(capabilitySupports(telegram, "voice")).toBe(true);
    expect(capabilitySupports(discord, "voice")).toBe(true);
    expect(capabilitySupports({ ...discord, voice: false }, "voice")).toBe(false);
    expect(capabilitySupports({ ...telegram, video: false }, "video")).toBe(false);
    expect(capabilitySupports(telegram, "image")).toBe(true);
  });

  it("reads each v2 key", () => {
    const yes = ["dm", "thread.replies", "thread.forum", "mentions.users", "reactions.add", "reactions.custom", "edit", "delete", "canvas", "presence.typing", "ephemeral", "live.join", "live.listen", "live.transcript", "inbound", "poll"];
    const no = ["thread.topics", "reactions.remove", "presence.status", "live.speak", "buttons.url", "buttons.callback", "events.create", "schedule.native"];
    for (const feature of yes) expect(capabilitySupports(RICH, feature), feature).toBe(true);
    for (const feature of no) expect(capabilitySupports(RICH, feature), feature).toBe(false);
    expect(capabilitySupports({ ...RICH, live: false }, "live.join")).toBe(false);
    expect(capabilitySupports({ ...RICH, inbound: { mode: "none", dedupe: true } }, "inbound")).toBe(false);
  });

  it("never supports an unknown feature", () => {
    expect(capabilitySupports(RICH, "teleport")).toBe(false);
    expect(capabilitySupports(RICH, "")).toBe(false);
    expect(capabilitySupports(RICH, "constructor")).toBe(false);
  });

  it("builds the channel_capability_unavailable refusal only for an undeclared feature", () => {
    expect(featureRefusal(RICH, "canvas")).toBeNull();
    expect(featureRefusal(telegram, "reactions.add")).toEqual({
      errorCode: "channel_capability_unavailable",
      detail: 'this provider does not declare "reactions.add"',
    });
  });
});

describe("wired features (review of PR #43)", () => {
  it("wires only what P1 routes really do: the attachment kinds and forum topics as destinations", () => {
    expect([...AGENT_WIRED_FEATURES].sort()).toEqual(["audio", "file", "image", "thread.topics", "video", "voice"]);
  });

  it("exposes declaration ∩ wired for every feature", () => {
    for (const caps of [RICH, telegram, discord]) {
      const effective = wiredCapabilities(caps);
      for (const feature of CHANNEL_FEATURES) {
        expect(capabilitySupports(effective, feature), feature).toBe(capabilitySupports(caps, feature) && AGENT_WIRED_FEATURES.has(feature));
      }
    }
  });

  it("hides a declared feature with no operation behind it (reactions, edit, dm, live, inbound)", () => {
    const effective = wiredCapabilities(RICH);
    expect(effective.reactions).toEqual({ add: false, remove: false, custom: false });
    expect(effective.edit).toEqual({ own: false });
    expect(effective.delete).toEqual({ own: false });
    expect(effective.dm).toEqual({ open: false, maxMembers: 0 });
    expect(effective.mentions).toEqual({ users: false, broadcast: "suppressed" });
    expect(effective.live).toBe(false);
    expect(effective.inbound).toEqual({ mode: "none", dedupe: false });
    expect(effective.poll).toBe(false);
    // Non-feature keys and wired features are kept as declared.
    expect(effective.text).toEqual(RICH.text);
    expect(effective.image).toEqual(RICH.image);
    expect(effective.voice).toEqual(RICH.voice);
    expect(effective.limits).toEqual(RICH.limits);
  });

  it("keeps a feature once a later change wires it, and is idempotent", () => {
    const wider = new Set([...AGENT_WIRED_FEATURES, "reactions.add", "edit"] as const);
    const effective = wiredCapabilities(RICH, wider);
    expect(effective.reactions).toEqual({ add: true, remove: false, custom: false });
    expect(effective.edit).toEqual({ own: true, windowSeconds: 900 });
    expect(wiredCapabilities(wiredCapabilities(RICH))).toEqual(wiredCapabilities(RICH));
  });
});
