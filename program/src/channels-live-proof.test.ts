import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DISCORD_TOKEN, TELEGRAM_TOKEN } from "./channels/app-fixture.js";
import {
  LIVE_PHRASE,
  MAX_POSTS_PER_PROVIDER,
  SILENCE_OGG_PATH,
  buildBrickPng,
  createGuardedFetch,
  defaultOutDir,
  dryRunConfig,
  evaluateInterlocks,
  idRef,
  liveConfig,
  main,
  runChannelsProof,
  virtualClock,
  writeEvidence,
  type ProofReport,
  type ProofRequest,
} from "../scripts/channels-live-proof.js";
import { buildSilenceOpus } from "../scripts/lib/ogg-opus.js";
import { SIM_DISCORD_CHANNEL_ID, SIM_TELEGRAM_CHAT_ID, createSimulatedApi } from "../scripts/lib/channels-proof-sim.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const LIVE_ENV = {
  CHANNELS_LIVE_PROOF: LIVE_PHRASE,
  MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
  MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN: DISCORD_TOKEN,
  CHANNELS_LIVE_TELEGRAM_CHAT_IDS: SIM_TELEGRAM_CHAT_ID,
  CHANNELS_LIVE_DISCORD_CHANNEL_IDS: SIM_DISCORD_CHANNEL_ID,
};

/** The LIVE code path (interlocks, allowlist, transport guard) against the simulated API, in virtual time. */
function liveAgainstSimulation(env: Record<string, string | undefined>, sim: Parameters<typeof createSimulatedApi>[0] extends infer S ? Partial<S> : never = {}) {
  const interlocks = evaluateInterlocks(env);
  if (interlocks.mode !== "live") throw new Error(`expected live, got ${interlocks.mode}`);
  const api = createSimulatedApi({ telegramToken: TELEGRAM_TOKEN, discordToken: DISCORD_TOKEN, ...sim });
  const lines: string[] = [];
  const config = liveConfig(interlocks, { fetchImpl: api.fetchImpl, realNetwork: false, clock: virtualClock(), out: (line) => void lines.push(line) });
  return { config, api, lines };
}

const statusOf = (report: ProofReport, spec: string, provider?: string) =>
  report.steps.filter((step) => step.spec.includes(spec) && (!provider || step.provider === provider)).map((step) => step.status);

describe("channels live proof: dry run (default)", () => {
  it("passes every step with the real adapters against the simulated API, offline, within the post budget", async () => {
    const originalFetch = globalThis.fetch;
    const lines: string[] = [];
    const api = createSimulatedApi({ telegramToken: TELEGRAM_TOKEN, discordToken: DISCORD_TOKEN });
    const report = await runChannelsProof(dryRunConfig({ out: (line) => void lines.push(line), fetchImpl: api.fetchImpl }));
    expect(globalThis.fetch).toBe(originalFetch);
    expect(report.steps.filter((step) => step.status === "FAIL")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.mode).toBe("dry-run");
    // Every acceptance item of spec section 10 that can run live has at least one PASS step per provider.
    for (const provider of ["telegram", "discord"]) {
      for (const spec of ["§8", "§4.2", "§10.1", "§10.2", "§10.3", "§10.4", "§10.5", "§10.6", "§10.7"]) {
        expect(statusOf(report, spec, provider), `${provider} ${spec}`).toContain("PASS");
      }
    }
    expect(statusOf(report, "§10.8")).toEqual(["PASS"]);
    expect(report.steps.filter((step) => step.status === "SKIP").map((step) => `${step.provider} ${step.spec}`)).toEqual(["discord §10.6"]);
    // Telegram voice uses sendVoice; Discord posts the @everyone text with allowed_mentions.parse = [] and a native voice message.
    const text = JSON.stringify(report.steps);
    expect(text).toContain("sendVoice");
    expect(text).toContain('"allowedMentionsParse":[]');
    expect(text).toContain('"discordVoice":{"flags":8192,"hasContent":false,"attachments":1');
    expect(text).not.toContain("voice→audio+transcript");
    expect(text).toContain("channel_cap_per_day");
    expect(text).toContain("channel_min_interval");
    expect(text).toContain("channel_phase_duplicate");
    expect(text).toContain("grant_widening_refused");
    expect(text).toContain("channel_capability_unavailable");
    // Budget and tags.
    for (const provider of ["telegram", "discord"] as const) {
      expect(report.providerPosts[provider]!.delivered).toBeLessThanOrEqual(MAX_POSTS_PER_PROVIDER);
      expect(report.providerPosts[provider]!.delivered).toBeGreaterThanOrEqual(7);
    }
    expect(report.posts.every((post) => post.tag.startsWith(`[tealbrick channels proof ${report.runId} step `))).toBe(true);
    // Offline: only the two API hosts were addressed, and no token leaked into the printed output.
    expect(new Set(api.requests.map((request) => request.host))).toEqual(new Set(["api.telegram.org", "discord.com"]));
    expect(lines.join("\n")).not.toContain(TELEGRAM_TOKEN);
    expect(lines.join("\n")).not.toContain(DISCORD_TOKEN);
    expect(lines.join("\n")).toContain("DRY RUN");
  });

  it("is the default: no live flag means dry run even when tokens are present", () => {
    expect(evaluateInterlocks({})).toEqual({ mode: "dry-run" });
    expect(evaluateInterlocks({ MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN, CHANNELS_LIVE_TELEGRAM_CHAT_IDS: "-100123" })).toEqual({ mode: "dry-run" });
  });

  it("the CLI main() prints the plan, exits 0 and writes no evidence unless CHANNELS_LIVE_OUT is set", async () => {
    const lines: string[] = [];
    expect(await main({}, [], (line) => void lines.push(line))).toBe(0);
    expect(lines.join("\n")).toContain("Plan:");
    expect(lines.join("\n")).toContain("evidence not written");
  });
});

describe("channels live proof: interlocks refuse to start", () => {
  const refused = (env: Record<string, string | undefined>, argv: string[] = []) => {
    const result = evaluateInterlocks(env, argv);
    if (result.mode !== "refused") throw new Error(`expected refusal, got ${result.mode}`);
    return result.missing.join(" | ");
  };

  it("needs the exact flag", () => {
    expect(refused({ ...LIVE_ENV, CHANNELS_LIVE_PROOF: "1" })).toContain(LIVE_PHRASE);
    expect(evaluateInterlocks(LIVE_ENV).mode).toBe("live");
  });

  it("names every missing token and allowlist, and never echoes a token value", () => {
    const missing = refused({ CHANNELS_LIVE_PROOF: LIVE_PHRASE });
    for (const name of ["MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN", "MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN", "CHANNELS_LIVE_TELEGRAM_CHAT_IDS", "CHANNELS_LIVE_DISCORD_CHANNEL_IDS"]) {
      expect(missing).toContain(name);
    }
    const malformed = refused({ ...LIVE_ENV, MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN: "not a token with spaces", CHANNELS_LIVE_DISCORD_CHANNEL_IDS: "general" });
    expect(malformed).toContain("malformed");
    expect(malformed).toContain("not a numeric id");
    expect(malformed).not.toContain("not a token");
  });

  it("refuses arguments, so a token can never travel on the command line", () => {
    expect(refused(LIVE_ENV, [`--token=${TELEGRAM_TOKEN}`])).toContain("no command-line arguments");
    expect(evaluateInterlocks({}, ["x"]).mode).toBe("refused");
  });

  it("lets CHANNELS_LIVE_PROVIDERS narrow the run, and rejects unknown providers", () => {
    const only = evaluateInterlocks({ ...LIVE_ENV, CHANNELS_LIVE_PROVIDERS: "telegram", MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN: undefined });
    expect(only).toMatchObject({ mode: "live", providers: ["telegram"] });
    expect(refused({ ...LIVE_ENV, CHANNELS_LIVE_PROVIDERS: "slack" })).toContain("telegram and discord");
  });

  it("main() in live mode with a missing interlock exits 2 and contacts nothing", async () => {
    const lines: string[] = [];
    const originalFetch = globalThis.fetch;
    let touched = false;
    globalThis.fetch = (async () => {
      touched = true;
      throw new Error("must not be called");
    }) as typeof fetch;
    try {
      expect(await main({ CHANNELS_LIVE_PROOF: LIVE_PHRASE }, [], (line) => void lines.push(line))).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(touched).toBe(false);
    expect(lines.join("\n")).toContain("REFUSED");
  });
});

describe("channels live proof: live code path against the simulated API", () => {
  it("passes end to end with tokens from env, and never prints them", async () => {
    const { config, lines } = liveAgainstSimulation(LIVE_ENV);
    const report = await runChannelsProof(config);
    expect(report.steps.filter((step) => step.status === "FAIL")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.mode).toBe("live");
    expect(lines.join("\n")).toContain("MODE: LIVE");
    expect(lines.join("\n")).not.toContain(TELEGRAM_TOKEN);
  });

  it("refuses a Telegram chat with a public username before anything is posted", async () => {
    const { config, api } = liveAgainstSimulation(LIVE_ENV, { telegramPublicUsername: "tealbrick_public_chat" });
    const report = await runChannelsProof(config);
    expect(report.ok).toBe(false);
    expect(report.aborted).toContain("public");
    expect(report.steps.find((step) => step.spec === "interlock")?.status).toBe("FAIL");
    expect(report.providerPosts.telegram).toMatchObject({ attempted: 0, delivered: 0 });
    expect(report.providerPosts.discord).toMatchObject({ attempted: 0, delivered: 0 });
    expect(api.requests.some((request) => request.path.endsWith("/sendMessage") || request.path.endsWith("/messages"))).toBe(false);
  });

  it("refuses a Discord channel that @everyone can view unless CHANNELS_LIVE_ALLOW_VISIBLE=1", async () => {
    const refusedRun = liveAgainstSimulation(LIVE_ENV, { discordEveryoneCanView: true });
    const report = await runChannelsProof(refusedRun.config);
    expect(report.aborted).toContain("public");
    expect(report.providerPosts.discord).toMatchObject({ attempted: 0 });
    expect(report.providerPosts.telegram).toMatchObject({ attempted: 0 });

    const waived = liveAgainstSimulation({ ...LIVE_ENV, CHANNELS_LIVE_ALLOW_VISIBLE: "1" }, { discordEveryoneCanView: true });
    const waivedReport = await runChannelsProof(waived.config);
    expect(waivedReport.ok).toBe(true);
    expect(waived.lines.join("\n")).toContain("CHANNELS_LIVE_ALLOW_VISIBLE=1");
  });

  it("says so, and goes on, when the Discord data cannot answer the visibility question", async () => {
    const { config, lines } = liveAgainstSimulation(LIVE_ENV, { discordPermissionsUnavailable: true });
    const report = await runChannelsProof(config);
    expect(report.ok).toBe(true);
    expect(lines.join("\n")).toContain("public-visibility check could not be computed");
    expect(JSON.stringify(report.steps)).toContain("visibilityCheck");
  });

  it("refuses a destination that is not on the allowlist: nothing is created or posted", async () => {
    const { config, api } = liveAgainstSimulation({ ...LIVE_ENV, CHANNELS_LIVE_TELEGRAM_CHAT_IDS: "-100999999999", CHANNELS_LIVE_DISCORD_CHANNEL_IDS: "123" });
    const report = await runChannelsProof(config);
    expect(report.ok).toBe(false);
    expect(report.aborted).toContain("no allowlisted destination");
    expect(report.steps.some((step) => step.spec === "§4.2" && step.status === "FAIL" && step.evidence.ignoredNotAllowlisted === 1)).toBe(true);
    expect(report.providerPosts.telegram).toMatchObject({ attempted: 0 });
    expect(api.requests.some((request) => request.path.endsWith("/sendMessage"))).toBe(false);
  });

  it("fails the hygiene step when a token reaches the logs", async () => {
    const { config, api } = liveAgainstSimulation(LIVE_ENV);
    let leaked = false;
    const leaky: typeof fetch = async (input, init) => {
      if (!leaked) {
        leaked = true;
        console.error(`debug: token ${TELEGRAM_TOKEN}`);
      }
      return api.fetchImpl(input, init);
    };
    const report = await runChannelsProof({ ...config, fetchImpl: leaky });
    expect(report.ok).toBe(false);
    expect(report.hygiene.leaks).toContain("captured logs and console");
    expect(statusOf(report, "§10.8")).toEqual(["FAIL"]);
  });
});

describe("channels live proof: transport guard", () => {
  const guard = (maxSends?: number) => {
    const log: ProofRequest[] = [];
    const api = createSimulatedApi({ telegramToken: TELEGRAM_TOKEN, discordToken: DISCORD_TOKEN });
    const fetchImpl = createGuardedFetch({
      base: api.fetchImpl,
      allowlist: { telegram: new Set([SIM_TELEGRAM_CHAT_ID]), discord: new Set([SIM_DISCORD_CHANNEL_ID]) },
      log,
      ...(maxSends ? { maxSends } : {}),
    });
    return { fetchImpl, log, api };
  };
  const telegramSend = (chat: string) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: "x" }) });

  it("blocks other hosts, other paths and destinations that are not allowlisted, before any request", async () => {
    const { fetchImpl, api } = guard();
    await expect(fetchImpl("https://example.com/", {})).rejects.toThrow("proof_transport_blocked");
    await expect(fetchImpl("https://discord.com/api/v10/guilds/1/members", { method: "GET" })).rejects.toThrow("proof_transport_blocked");
    await expect(fetchImpl(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, telegramSend(SIM_TELEGRAM_CHAT_ID))).rejects.toThrow("proof_transport_blocked");
    await expect(fetchImpl(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, telegramSend("-100777"))).rejects.toThrow("allowlist");
    await expect(fetchImpl("https://discord.com/api/v10/channels/42/messages", { method: "POST", body: "{}" })).rejects.toThrow("allowlist");
    expect(api.requests).toEqual([]);
  });

  it("stops the sends at the budget", async () => {
    const { fetchImpl, log } = guard(2);
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    expect((await fetchImpl(url, telegramSend(SIM_TELEGRAM_CHAT_ID))).status).toBe(200);
    expect((await fetchImpl(url, telegramSend(SIM_TELEGRAM_CHAT_ID))).status).toBe(200);
    await expect(fetchImpl(url, telegramSend(SIM_TELEGRAM_CHAT_ID))).rejects.toThrow("budget");
    expect(log.filter((entry) => entry.delivered)).toHaveLength(2);
  });
});

describe("channels live proof: evidence report", () => {
  it("writes JSON and Markdown without tokens, chat titles or message text, and refuses a report with a token", async () => {
    const lines: string[] = [];
    const report = await runChannelsProof(dryRunConfig({ out: (line) => void lines.push(line) }));
    const dir = await mkdtemp(path.join(os.tmpdir(), "channels-proof-evidence-"));
    temporary.push(dir);
    const written = await writeEvidence(report, path.join(dir, "nested"), [TELEGRAM_TOKEN, DISCORD_TOKEN]);
    const json = await readFile(written.json, "utf8");
    const markdown = await readFile(written.markdown, "utf8");
    expect(await readdir(path.join(dir, "nested"))).toEqual(["evidence.json", "evidence.md"]);
    for (const text of [json, markdown]) {
      expect(text).not.toContain(TELEGRAM_TOKEN);
      expect(text).not.toContain(DISCORD_TOKEN);
      expect(text).not.toContain("simulated test group");
      expect(text).not.toContain("simulated test server");
      expect(text).toContain(report.runId);
    }
    expect(markdown).toContain("perDay 3, minInterval 60 s");
    expect(JSON.parse(json).providerPosts.telegram.limit).toBe(MAX_POSTS_PER_PROVIDER);
    await expect(writeEvidence({ ...report, cleanup: [`oops ${TELEGRAM_TOKEN}`] }, path.join(dir, "bad"), [TELEGRAM_TOKEN])).rejects.toThrow("token");
  });

  it("defaults to the artifacts directory with a timestamp, and hashes personal Telegram chats", () => {
    expect(defaultOutDir(new Date("2026-10-09T15:30:00.123Z"))).toBe("/Users/puma/work/artifacts/marketplace-channels-0.2.0/20261009T153000Z");
    expect(idRef("telegram", "-1001234")).toBe("-1001234");
    expect(idRef("telegram", "555123")).toMatch(/^personal:[0-9a-f]{12}$/u);
    expect(idRef("discord", "700000000000000001")).toBe("700000000000000001");
  });
});

describe("channels live proof: payload fixtures", () => {
  it("the committed OGG/Opus file is exactly what the deterministic generator writes", async () => {
    const committed = await readFile(SILENCE_OGG_PATH);
    expect(Buffer.compare(committed, Buffer.from(buildSilenceOpus()))).toBe(0);
    expect(committed.length).toBeLessThan(1024);
    expect(committed.subarray(0, 4).toString("latin1")).toBe("OggS");
    expect(committed.includes(Buffer.from("OpusHead"))).toBe(true);
    expect(committed.includes(Buffer.from("OpusTags"))).toBe(true);
  });

  it("decodes as about one second of Opus when ffprobe is installed", () => {
    let output = "";
    try {
      output = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate:format=duration", "-of", "default=nw=1", SILENCE_OGG_PATH], { encoding: "utf8" });
    } catch {
      return; // ffprobe is optional
    }
    expect(output).toContain("codec_name=opus");
    expect(output).toContain("channels=1");
    expect(Number(/duration=([0-9.]+)/u.exec(output)?.[1])).toBeGreaterThan(0.95);
  });

  it("builds a valid PNG", () => {
    const png = buildBrickPng();
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.includes(Buffer.from("IEND"))).toBe(true);
    expect(png.length).toBeLessThan(2048);
  });
});
