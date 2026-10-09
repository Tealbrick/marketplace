import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CHANNEL_POLICY,
  MIB,
  channelPayloadDigest,
  confirmEventLive,
  effectiveCaps,
  evaluateContent,
  eventHostAllowed,
  globMatches,
  grantCoversPost,
  grantWithinCeiling,
  insideScheduleWindow,
  isNarrowing,
  standingGrantDigest,
  validatePolicy,
  type ChannelPolicy,
  type ChannelProviderCapabilities,
  type ChannelPolicyInput,
  type PostFacts,
  type StandingGrantTerms,
} from "./policy.js";

const NOW = "2026-10-09T12:00:00.000Z";
const IN_30_DAYS = "2026-11-08T12:00:00.000Z";

const telegram: ChannelProviderCapabilities = {
  "send.text": true,
  "send.maxChars": 4096,
  "send.files": { types: ["image/png", "image/jpeg", "application/pdf"], maxBytes: 50 * MIB, maxCount: 10 },
};

function policy(input: ChannelPolicyInput = {}, provider?: ChannelProviderCapabilities): ChannelPolicy {
  const result = validatePolicy(input, provider);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.policy;
}

function terms(overrides: Partial<StandingGrantTerms> = {}): StandingGrantTerms {
  return {
    caps: { perDay: 3, minIntervalSeconds: 900, onePerPhase: true },
    scope: {
      phases: ["announce", "reminder"],
      campaignRefs: ["https://lu.ma/*"],
      files: { types: ["image/png"], maxBytes: 5 * MIB, maxCount: 1 },
      maxChars: 1000,
      immediate: true,
      scheduled: true,
    },
    notBefore: null,
    expires: IN_30_DAYS,
    ...overrides,
  };
}

function post(overrides: Partial<PostFacts> = {}): PostFacts {
  return {
    mode: "immediate",
    text: "Meetup tonight",
    attachments: [],
    campaign: { ref: "https://lu.ma/abc", phase: "announce" },
    ...overrides,
  };
}

describe("validatePolicy", () => {
  it("fills the §4.3 defaults", () => {
    const result = policy();
    expect(result).toEqual({
      standingGrants: "disabled",
      caps: { perDay: 6, minIntervalSeconds: 600, onePerPhase: true },
      content: {
        files: {
          allowed: true,
          types: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
          maxBytes: 10 * MIB,
          maxCount: 4,
        },
        requireConfirmedEvent: false,
        listingHosts: [],
        denyPatterns: [],
      },
      schedule: { maxPendingPerAgent: 12 },
    });
    // The frozen default is never mutated by normalisation.
    expect(DEFAULT_CHANNEL_POLICY.caps.perDay).toBe(6);
  });

  it("intersects defaults with the provider and takes its maxChars", () => {
    const result = policy({}, telegram);
    expect(result.content.maxChars).toBe(4096);
    expect(result.content.files.types).toEqual(["image/png", "image/jpeg", "application/pdf"]);
    expect(result.content.files.maxBytes).toBe(10 * MIB);
    const noFiles = policy({}, { ...telegram, "send.files": false });
    expect(noFiles.content.files.allowed).toBe(false);
  });

  it("normalises aliases and hosts", () => {
    const result = policy({
      content: { files: { types: ["PNG", "jpg", "pdf"] }, listingHosts: ["Lu.Ma.", "sola.day"], requireConfirmedEvent: true },
    });
    expect(result.content.files.types).toEqual(["image/png", "image/jpeg", "application/pdf"]);
    expect(result.content.listingHosts).toEqual(["lu.ma", "sola.day"]);
  });

  it("refuses explicit values wider than the provider and invalid fields", () => {
    const result = validatePolicy(
      {
        caps: { perDay: 0, perHour: 10, minIntervalSeconds: -1 },
        content: {
          maxChars: 5000,
          files: { types: ["image/webp"], maxBytes: 60 * MIB },
          requireConfirmedEvent: true,
          listingHosts: [],
          denyPatterns: [""],
        },
        schedule: { window: { timeZone: "Mars/Olympus", start: "25:00", end: "08:00" } },
        recipients: ["not-an-email"],
      },
      telegram,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("channel_policy_invalid");
    const fields = result.errors.map((error) => error.field);
    for (const field of [
      "caps.perDay",
      "caps.minIntervalSeconds",
      "content.maxChars",
      "content.files.types",
      "content.files.maxBytes",
      "content.listingHosts",
      "content.denyPatterns",
      "schedule.window",
      "recipients",
    ]) {
      expect(fields).toContain(field);
    }
  });

  it("refuses perHour above perDay", () => {
    const result = validatePolicy({ caps: { perDay: 2, perHour: 3 } });
    expect(result.ok).toBe(false);
  });
});

describe("standing grants vs ceiling", () => {
  const ceiling = policy({ standingGrants: "allowed", content: { maxChars: 2000 } });

  it("accepts a grant inside the ceiling", () => {
    expect(grantWithinCeiling(terms(), ceiling, { now: NOW })).toEqual({ ok: true });
  });

  it("refuses when standing grants are disabled", () => {
    expect(grantWithinCeiling(terms(), policy(), { now: NOW })).toEqual({
      ok: false,
      error: "standing_grants_disabled",
      fields: ["standingGrants"],
    });
  });

  it("lists every field wider than the ceiling", () => {
    const result = grantWithinCeiling(
      terms({
        caps: { perDay: 7, minIntervalSeconds: 60, onePerPhase: false },
        scope: {
          files: { types: ["image/gif"], maxBytes: 20 * MIB, maxCount: 5 },
          maxChars: 3000,
          immediate: true,
          scheduled: false,
        },
        expires: "2027-03-01T00:00:00.000Z",
      }),
      ceiling,
      { now: NOW },
    );
    expect(result).toEqual({
      ok: false,
      error: "grant_exceeds_ceiling",
      fields: [
        "caps.perDay",
        "caps.minIntervalSeconds",
        "caps.onePerPhase",
        "scope.maxChars",
        "scope.files.types",
        "scope.files.maxBytes",
        "scope.files.maxCount",
        "expires",
      ],
    });
  });

  it("measures the 90-day limit from approval time", () => {
    const expires = "2027-01-10T00:00:00.000Z"; // NOW + 93 days
    expect(grantWithinCeiling(terms({ expires }), ceiling, { now: NOW }).ok).toBe(false);
    expect(grantWithinCeiling(terms({ expires }), ceiling, { now: NOW, approvedAt: "2026-12-01T00:00:00.000Z" }).ok).toBe(true);
  });

  it("refuses files when the ceiling forbids them", () => {
    const noFiles = policy({ standingGrants: "allowed", content: { files: { allowed: false } } });
    const result = grantWithinCeiling(terms(), noFiles, { now: NOW });
    expect(result.ok === false && result.fields).toEqual(["scope.files"]);
    expect(grantWithinCeiling(terms({ scope: { ...terms().scope, files: false } }), noFiles, { now: NOW }).ok).toBe(true);
  });
});

describe("isNarrowing", () => {
  const current = terms({ caps: { perDay: 3, perHour: 2, minIntervalSeconds: 900, onePerPhase: true } });
  const narrowCases: Array<[string, Partial<StandingGrantTerms>]> = [
    ["identical", {}],
    ["fewer per day", { caps: { ...current.caps, perDay: 2 } }],
    ["longer interval", { caps: { ...current.caps, minIntervalSeconds: 1800 } }],
    ["fewer phases", { scope: { ...current.scope, phases: ["announce"] } }],
    ["no files", { scope: { ...current.scope, files: false } }],
    ["scheduled only", { scope: { ...current.scope, immediate: false } }],
    ["earlier expiry", { expires: "2026-10-20T00:00:00.000Z" }],
    ["later start", { notBefore: "2026-10-10T00:00:00.000Z" }],
  ];
  for (const [name, change] of narrowCases) {
    it(`accepts ${name}`, () => {
      expect(isNarrowing(current, { ...current, ...change })).toEqual({ ok: true });
    });
  }

  const wideCases: Array<[string, Partial<StandingGrantTerms>, string]> = [
    ["more per day", { caps: { ...current.caps, perDay: 4 } }, "caps.perDay"],
    ["dropping perHour", { caps: { perDay: 3, minIntervalSeconds: 900, onePerPhase: true } }, "caps.perHour"],
    ["shorter interval", { caps: { ...current.caps, minIntervalSeconds: 600 } }, "caps.minIntervalSeconds"],
    ["onePerPhase off", { caps: { ...current.caps, onePerPhase: false } }, "caps.onePerPhase"],
    ["any phase", { scope: { ...current.scope, phases: undefined } }, "scope.phases"],
    ["new phase", { scope: { ...current.scope, phases: ["announce", "recap"] } }, "scope.phases"],
    ["new campaign glob", { scope: { ...current.scope, campaignRefs: ["https://*"] } }, "scope.campaignRefs"],
    ["more chars", { scope: { ...current.scope, maxChars: 2000 } }, "scope.maxChars"],
    ["new file type", { scope: { ...current.scope, files: { types: ["image/png", "application/pdf"], maxBytes: 5 * MIB, maxCount: 1 } } }, "scope.files.types"],
    ["bigger files", { scope: { ...current.scope, files: { types: ["image/png"], maxBytes: 6 * MIB, maxCount: 1 } } }, "scope.files.maxBytes"],
    ["later expiry", { expires: "2026-12-01T00:00:00.000Z" }, "expires"],
  ];
  for (const [name, change, field] of wideCases) {
    it(`refuses ${name}`, () => {
      const result = isNarrowing(current, { ...current, ...change });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("grant_widening_refused");
      expect(result.fields).toContain(field);
    });
  }

  it("refuses enabling a mode or files that were off", () => {
    const off = terms({ scope: { ...current.scope, files: false, immediate: false } });
    const result = isNarrowing(off, terms());
    expect(result.ok === false && result.fields).toEqual(expect.arrayContaining(["scope.files", "scope.immediate"]));
  });

  it("refuses an earlier start", () => {
    const started = terms({ notBefore: "2026-10-10T00:00:00.000Z" });
    expect(isNarrowing(started, terms()).ok).toBe(false);
  });
});

describe("effectiveCaps", () => {
  it("takes the tighter value per field", () => {
    expect(
      effectiveCaps(
        { perDay: 10, perHour: 2, minIntervalSeconds: 300, onePerPhase: false },
        { perDay: 6, minIntervalSeconds: 600, onePerPhase: true },
      ),
    ).toEqual({ perDay: 6, perHour: 2, minIntervalSeconds: 600, onePerPhase: true });
    expect(effectiveCaps(null, { perDay: 6, perHour: 3, minIntervalSeconds: 600, onePerPhase: false })).toEqual({
      perDay: 6,
      perHour: 3,
      minIntervalSeconds: 600,
      onePerPhase: false,
    });
  });
});

describe("grantCoversPost", () => {
  const active = { ...terms(), status: "active" };

  it("covers a matching post", () => {
    expect(grantCoversPost(active, post(), NOW)).toEqual({ ok: true });
  });

  it("matches campaign globs case-insensitively and anchored", () => {
    expect(globMatches("https://lu.ma/*", "HTTPS://LU.MA/x")).toBe(true);
    expect(globMatches("https://lu.ma/*", "https://lu.ma.evil.io/x")).toBe(false);
    expect(globMatches("https://lu.ma/*", "xhttps://lu.ma/x")).toBe(false);
    expect(globMatches("a.b", "aXb")).toBe(false);
    expect(grantCoversPost(active, post({ campaign: { ref: "https://evil.io/lu.ma/", phase: "announce" } }), NOW)).toEqual({
      ok: false,
      reasons: ["campaign_ref_not_covered"],
    });
  });

  it("checks status, window, phase, files, chars and mode", () => {
    const reasons = (grant: typeof active, facts: PostFacts, now = NOW) => {
      const result = grantCoversPost(grant, facts, now);
      return result.ok ? [] : result.reasons;
    };
    expect(reasons({ ...active, status: "suspended" }, post())).toContain("grant_not_active");
    expect(reasons({ ...active, notBefore: "2026-10-10T00:00:00.000Z" }, post())).toContain("grant_not_yet_valid");
    expect(reasons(active, post(), "2026-11-09T00:00:00.000Z")).toContain("grant_expired");
    expect(reasons(active, post({ campaign: { ref: "https://lu.ma/x", phase: "recap" } }))).toEqual(["phase_not_covered"]);
    expect(reasons(active, post({ campaign: null }))).toEqual(["phase_not_covered", "campaign_ref_not_covered"]);
    expect(reasons(active, post({ text: "x".repeat(1001) }))).toEqual(["text_too_long_for_grant"]);
    expect(
      reasons(active, post({ attachments: [{ contentType: "application/pdf", bytes: 10 }, { contentType: "image/png", bytes: 6 * MIB }] })),
    ).toEqual(["too_many_files_for_grant", "file_type_not_covered", "file_too_large_for_grant"]);
    expect(reasons({ ...active, scope: { ...active.scope, files: false } }, post({ attachments: [{ contentType: "image/png", bytes: 1 }] }))).toEqual([
      "files_not_covered",
    ]);
    expect(reasons({ ...active, scope: { ...active.scope, immediate: false } }, post())).toEqual(["mode_immediate_not_covered"]);
    expect(reasons(active, post({ mode: "scheduled", sendAt: "2026-11-10T00:00:00.000Z" }))).toEqual(["send_at_after_grant"]);
    expect(reasons(active, post({ mode: "scheduled", sendAt: "2026-10-10T00:00:00.000Z" }))).toEqual([]);
  });
});

describe("evaluateContent", () => {
  const confirmed = policy({
    content: {
      requireConfirmedEvent: true,
      listingHosts: ["sola.day", "lu.ma"],
      denyPatterns: ["Crypto Giveaway"],
    },
  });
  const errors = (result: ReturnType<typeof evaluateContent>) => (result.ok ? [] : result.errors);

  it("accepts a valid post", () => {
    expect(evaluateContent(post(), confirmed, telegram)).toEqual({ ok: true });
  });

  it("refuses long texts instead of truncating", () => {
    const discord = { ...telegram, "send.maxChars": 2000 };
    expect(errors(evaluateContent(post({ text: "x".repeat(2001) }), policy(), discord))).toEqual(["channel_text_too_long"]);
    expect(errors(evaluateContent(post({ text: "x".repeat(2000) }), policy(), discord))).toEqual([]);
    // Owner maxChars below the provider wins.
    expect(errors(evaluateContent(post({ text: "x".repeat(101) }), policy({ content: { maxChars: 100 } }), telegram))).toEqual([
      "channel_text_too_long",
    ]);
  });

  it("applies file rules as policy ∩ provider", () => {
    const one = (contentType: string, bytes = 1) => ({ contentType, bytes });
    expect(errors(evaluateContent(post({ attachments: [one("image/png")] }), policy({ content: { files: { allowed: false } } }), telegram))).toEqual([
      "channel_files_not_allowed",
    ]);
    expect(errors(evaluateContent(post({ attachments: [one("image/png")] }), policy(), { ...telegram, "send.files": false }))).toEqual([
      "channel_files_not_allowed",
    ]);
    // webp is in the default policy but not in this provider's list.
    expect(errors(evaluateContent(post({ attachments: [one("image/webp")] }), policy(), telegram))).toEqual(["channel_file_type_not_allowed"]);
    expect(errors(evaluateContent(post({ attachments: [one("image/png", 10 * MIB + 1)] }), policy(), telegram))).toEqual(["channel_file_too_large"]);
    expect(errors(evaluateContent(post({ attachments: Array.from({ length: 5 }, () => one("image/png")) }), policy(), telegram))).toEqual([
      "channel_too_many_files",
    ]);
  });

  it("refuses deny patterns case-insensitively as substrings", () => {
    expect(errors(evaluateContent(post({ text: "Join our CRYPTO giveaway!!" }), confirmed, telegram))).toEqual(["channel_content_denied"]);
  });

  it("requires https on a listing host or its subdomain, and refuses lookalikes", () => {
    expect(eventHostAllowed("https://sola.day/e/1", ["sola.day"])).toBe(true);
    expect(eventHostAllowed("https://app.sola.day/e/1", ["sola.day"])).toBe(true);
    expect(eventHostAllowed("https://SOLA.DAY./e/1", ["sola.day"])).toBe(true);
    for (const ref of [
      "https://sola.day.evil.io/e/1",
      "https://evilsola.day/e/1",
      "http://sola.day/e/1",
      "https://sola.day@evil.io/e/1",
      "https://user:pw@sola.day/e/1",
      "sola.day/e/1",
      "",
    ]) {
      expect(eventHostAllowed(ref, ["sola.day"])).toBe(false);
    }
    expect(
      errors(evaluateContent(post({ campaign: { ref: "https://sola.day.evil.io/e/1", phase: "announce" } }), confirmed, telegram)),
    ).toEqual(["channel_event_unconfirmed"]);
    expect(errors(evaluateContent(post({ campaign: null }), confirmed, telegram))).toEqual(["channel_event_unconfirmed"]);
  });

  it("enforces the local schedule window, including overnight windows and weekdays", () => {
    const window = { timeZone: "Asia/Taipei", start: "09:00", end: "21:00" };
    const windowed = policy({ schedule: { window } });
    // 12:00Z = 20:00 Taipei (inside); 14:00Z = 22:00 Taipei (outside).
    expect(errors(evaluateContent(post(), windowed, telegram, { now: NOW }))).toEqual([]);
    expect(errors(evaluateContent(post(), windowed, telegram, { now: "2026-10-09T14:00:00.000Z" }))).toEqual(["channel_outside_window"]);
    expect(errors(evaluateContent(post({ sendAt: "2026-10-10T02:00:00.000Z" }), windowed, telegram, { now: "2026-10-09T14:00:00.000Z" }))).toEqual([]);
    const overnight = { timeZone: "UTC", start: "22:00", end: "06:00" };
    expect(insideScheduleWindow(overnight, new Date("2026-10-09T23:30:00Z"))).toBe(true);
    expect(insideScheduleWindow(overnight, new Date("2026-10-09T05:59:00Z"))).toBe(true);
    expect(insideScheduleWindow(overnight, new Date("2026-10-09T06:00:00Z"))).toBe(false);
    // 2026-10-09 is a Friday (5).
    expect(insideScheduleWindow({ ...window, days: [1, 2, 3, 4, 5] }, new Date(NOW))).toBe(true);
    expect(insideScheduleWindow({ ...window, days: [0, 6] }, new Date(NOW))).toBe(false);
  });
});

describe("confirmEventLive", () => {
  it("is true only for a 2xx answer", async () => {
    const ok = vi.fn(async () => new Response("ok", { status: 200 }));
    expect(await confirmEventLive("https://lu.ma/x", { fetchImpl: ok as unknown as typeof fetch })).toBe(true);
    expect(ok).toHaveBeenCalledWith("https://lu.ma/x", expect.objectContaining({ redirect: "follow" }));
    const missing = vi.fn(async () => new Response("gone", { status: 404 }));
    expect(await confirmEventLive("https://lu.ma/x", { fetchImpl: missing as unknown as typeof fetch })).toBe(false);
  });

  it("is false on errors, timeouts and non-https URLs", async () => {
    const boom = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await confirmEventLive("https://lu.ma/x", { fetchImpl: boom as unknown as typeof fetch })).toBe(false);
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    expect(await confirmEventLive("https://lu.ma/x", { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 20 })).toBe(false);
    const never = vi.fn();
    expect(await confirmEventLive("http://lu.ma/x", { fetchImpl: never as unknown as typeof fetch })).toBe(false);
    expect(await confirmEventLive("not a url", { fetchImpl: never as unknown as typeof fetch })).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });
});

describe("digests", () => {
  const base = {
    workspace: "org-1",
    channelId: "chn_1",
    provider: "telegram",
    destination: "-100123",
    op: "post",
    text: "Meetup tonight",
    attachments: [{ sha256: "a".repeat(64), contentType: "image/png", name: "poster.png" }],
    campaign: { ref: "https://lu.ma/x", phase: "announce" },
  };

  it("is stable across key order and returns 64 hex", () => {
    const digest = channelPayloadDigest(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    const reordered = channelPayloadDigest({
      campaign: { phase: "announce", ref: "https://lu.ma/x" },
      attachments: [{ name: "poster.png", contentType: "image/png", sha256: "a".repeat(64) }],
      text: "Meetup tonight",
      op: "post",
      destination: "-100123",
      provider: "telegram",
      channelId: "chn_1",
      workspace: "org-1",
    });
    expect(reordered).toBe(digest);
  });

  it("changes with text, file bytes, tenant, destination or send time", () => {
    const digest = channelPayloadDigest(base);
    expect(channelPayloadDigest({ ...base, text: "Meetup tonight!" })).not.toBe(digest);
    expect(channelPayloadDigest({ ...base, attachments: [{ ...base.attachments[0]!, sha256: "b".repeat(64) }] })).not.toBe(digest);
    expect(channelPayloadDigest({ ...base, workspace: "org-2" })).not.toBe(digest);
    expect(channelPayloadDigest({ ...base, destination: "-100124" })).not.toBe(digest);
    expect(channelPayloadDigest({ ...base, sendAt: NOW })).not.toBe(digest);
    // sendAt is normalised to an ISO instant.
    expect(channelPayloadDigest({ ...base, sendAt: "2026-10-09T20:00:00+08:00" })).toBe(channelPayloadDigest({ ...base, sendAt: NOW }));
    // No campaign and an empty campaign are the same payload.
    expect(channelPayloadDigest({ ...base, campaign: undefined })).toBe(channelPayloadDigest({ ...base, campaign: {} }));
  });

  it("binds every grant term", () => {
    const input = { workspace: "org-1", channelId: "chn_1", agentId: "agent-1", consentId: "c1", purpose: "weekly", terms: terms() };
    const digest = standingGrantDigest(input);
    expect(standingGrantDigest({ ...input, terms: terms({ caps: { perDay: 2, minIntervalSeconds: 900, onePerPhase: true } }) })).not.toBe(digest);
    expect(standingGrantDigest({ ...input, consentId: "c2" })).not.toBe(digest);
  });
});
