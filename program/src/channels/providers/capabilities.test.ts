import { describe, expect, it } from "vitest";
import { AGENT_WIRED_FEATURES, CHANNEL_FEATURES, capabilitySupports, featureRefusal, markupSupported, pollProblem, wiredCapabilities } from "./capabilities.js";
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
  poll: { questionMaxChars: 300, minOptions: 2, maxOptions: 10, optionMaxChars: 100, multiple: false },
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

  it("declares only what the adapters do today", () => {
    const declared = (caps: ChannelCapabilities) =>
      CHANNEL_FEATURES.filter((feature) => !["image", "file", "audio", "voice", "video"].includes(feature) && capabilitySupports(caps, feature));
    expect(declared(telegram)).toEqual(["thread.replies", "thread.topics", "reactions.add", "reactions.remove", "edit", "delete", "poll", "markup.markdown-v2", "inbound"]);
    expect(declared(discord)).toEqual(["dm", "thread.replies", "mentions.users", "reactions.add", "reactions.remove", "reactions.custom", "edit", "delete", "poll", "inbound"]);
    for (const caps of [telegram, discord]) {
      expect(caps.live).toBe(false);
      expect(caps.events).toEqual({ create: false });
    }
    // The inbound worker receives for every adapter: Telegram by webhook, Discord over the gateway socket.
    expect(telegram.inbound).toEqual({ mode: "webhook", dedupe: true });
    expect(discord.inbound).toEqual({ mode: "socket", dedupe: true });
    expect(telegram.thread).toEqual({ replies: true, topics: true, forum: false });
    expect(discord.thread).toEqual({ replies: true, topics: false, forum: false });
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
    expect(featureRefusal(telegram, "dm")).toEqual({
      errorCode: "channel_capability_unavailable",
      detail: 'this provider does not declare "dm"',
    });
  });
});

describe("wired features (review of PR #43)", () => {
  it("wires only what the routes really do: attachment kinds, forum topics, inbound, reply, and the routes v2 operations", () => {
    expect([...AGENT_WIRED_FEATURES].sort()).toEqual([
      "audio",
      "delete",
      "dm",
      "edit",
      "file",
      "image",
      "inbound",
      "markup.markdown-v2",
      "mentions.users",
      "poll",
      "reactions.add",
      "reactions.custom",
      "reactions.remove",
      "thread.replies",
      "thread.topics",
      "video",
      "voice",
    ]);
  });

  it("exposes declaration ∩ wired for every feature", () => {
    for (const caps of [RICH, telegram, discord]) {
      const effective = wiredCapabilities(caps);
      for (const feature of CHANNEL_FEATURES) {
        expect(capabilitySupports(effective, feature), feature).toBe(capabilitySupports(caps, feature) && AGENT_WIRED_FEATURES.has(feature));
      }
    }
  });

  it("hides a declared feature with no operation behind it (live, canvas, presence) and shows the routes v2 ones", () => {
    const effective = wiredCapabilities(RICH);
    expect(effective.reactions).toEqual(RICH.reactions);
    expect(effective.edit).toEqual(RICH.edit);
    expect(effective.delete).toEqual(RICH.delete);
    expect(effective.dm).toEqual(RICH.dm);
    expect(effective.mentions).toEqual({ users: RICH.mentions.users, broadcast: "suppressed" });
    expect(effective.live).toBe(false);
    expect(effective.canvas).toBe(false);
    expect(effective.presence).toEqual({ typing: false, status: false });
    expect(effective.inbound).toEqual(RICH.inbound);
    expect(effective.poll).toEqual(RICH.poll);
    // Non-feature keys and wired features are kept as declared.
    expect(effective.text).toEqual(RICH.text);
    expect(effective.image).toEqual(RICH.image);
    expect(effective.voice).toEqual(RICH.voice);
    expect(effective.limits).toEqual(RICH.limits);
  });

  it("keeps a feature only while it is wired, and is idempotent", () => {
    const narrower = new Set([...AGENT_WIRED_FEATURES].filter((feature) => feature !== "reactions.remove" && feature !== "edit"));
    const effective = wiredCapabilities(RICH, narrower);
    expect(effective.reactions).toEqual({ add: true, remove: false, custom: RICH.reactions.custom });
    expect(effective.edit).toEqual({ own: false });
    expect(wiredCapabilities(RICH).edit).toEqual({ own: true, windowSeconds: 900 });
    expect(wiredCapabilities(wiredCapabilities(RICH))).toEqual(wiredCapabilities(RICH));
  });

  it("offers a markup option only while its markup feature is wired (the post body markup)", () => {
    expect(telegram.markupOptions).toEqual(["markdown-v2"]);
    expect(wiredCapabilities(telegram).markupOptions).toEqual(["markdown-v2"]);
    const without = new Set([...AGENT_WIRED_FEATURES].filter((feature) => feature !== "markup.markdown-v2"));
    expect(wiredCapabilities(telegram, without)).not.toHaveProperty("markupOptions");
    expect(wiredCapabilities(discord)).not.toHaveProperty("markupOptions");
  });
});

describe("markupSupported and pollProblem", () => {
  it("allows the default markup and listed options only", () => {
    expect(markupSupported(telegram, "plain")).toBe(true);
    expect(markupSupported(telegram, "markdown-v2")).toBe(true);
    expect(markupSupported(telegram, "html")).toBe(false);
    expect(markupSupported(discord, "markdown-v2")).toBe(false);
    expect(capabilitySupports(discord, "markup.markdown-v2")).toBe(false);
  });

  it("refuses an undeclared poll and checks every limit without cutting", () => {
    expect(pollProblem({ ...telegram, poll: false }, { question: "q", options: ["a", "b"] })).toMatchObject({ errorCode: "channel_capability_unavailable" });
    expect(pollProblem(RICH, undefined)).toBeUndefined();
    expect(pollProblem(RICH, { question: "q", options: ["a", "b"] })).toBeUndefined();
    expect(pollProblem(RICH, { question: "q", options: ["a", "b"], allowsMultiple: true })).toMatchObject({ errorCode: "channel_poll_invalid" });
    expect(pollProblem(RICH, { question: "q", options: ["a", "b\u202e"] })).toMatchObject({ errorCode: "channel_poll_invalid" });
    expect(pollProblem(RICH, { question: "q", options: ["a", "b"], durationHours: 1 })).toMatchObject({ errorCode: "channel_poll_invalid" });
    expect(pollProblem(RICH, { question: "q", options: "ab" as never })).toMatchObject({ errorCode: "channel_poll_invalid" });
    expect(pollProblem(RICH, null as never)).toMatchObject({ errorCode: "channel_poll_invalid" });
  });
});
