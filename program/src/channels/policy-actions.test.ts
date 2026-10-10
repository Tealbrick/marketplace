import { describe, expect, it } from "vitest";

import {
  DEFAULT_ACTION_CAPS,
  GRANT_SCOPE_FLAGS,
  effectiveCaps,
  channelPayloadDigest,
  grantCoversPost,
  grantWithinCeiling,
  isNarrowing,
  standingGrantDigest,
  validatePolicy,
  type ChannelPayloadDigestInput,
  type PostFacts,
  type StandingGrantTerms,
} from "./policy.js";

// Channels P2 routes v2: the grant scope flags (review R4) and the payload digest fields (review R2).

const NOW = "2026-10-09T12:00:00.000Z";

function terms(scope: Partial<StandingGrantTerms["scope"]> = {}): StandingGrantTerms {
  return {
    caps: { perDay: 3, minIntervalSeconds: 600, onePerPhase: true },
    scope: { files: false, immediate: true, scheduled: false, ...scope },
    notBefore: null,
    expires: "2026-11-01T00:00:00.000Z",
  };
}

const post = (facts: Partial<PostFacts> = {}): PostFacts => ({ mode: "immediate", text: "", attachments: [], ...facts });
const ceiling = (() => {
  const result = validatePolicy({ standingGrants: "allowed", caps: { perDay: 6, minIntervalSeconds: 600, onePerPhase: true } });
  if (!result.ok) throw new Error("policy");
  return result.policy;
})();

describe("standing grant scope flags (R4)", () => {
  it("keeps a grant digest that was stored before the flags existed, and digests an explicit false like an absent flag", () => {
    // Computed with the Marketplace 0.2.0 code (before routes v2) and stored here unchanged.
    const stored = {
      workspace: "tenant-community",
      channelId: "ch_1",
      agentId: "agent-1",
      consentId: "consent-row-1",
      purpose: "weekly meetup",
      terms: {
        caps: { perDay: 3, perHour: 2, minIntervalSeconds: 600, onePerPhase: true },
        scope: { phases: ["announce" as const], files: { types: ["image/png"], maxBytes: 1000, maxCount: 1 }, maxChars: 500, immediate: true, scheduled: false },
        notBefore: null,
        expires: "2026-11-01T00:00:00.000Z",
      },
    };
    expect(standingGrantDigest(stored)).toBe("e2aedd6fa0fd51893a9177cff52adb7f96ce839c041557218adf89afae8695a4");
    // A stored grant with replies: true (P2 inbound) keeps its digest too.
    expect(standingGrantDigest({ ...stored, terms: { ...stored.terms, scope: { ...stored.terms.scope, replies: true } } })).toBe(
      "64b7435fdc0bac4784018005dcf1f051cce3515b471ee5114446dc4d0535eaa7",
    );
    const allFalse = Object.fromEntries(GRANT_SCOPE_FLAGS.map((flag) => [flag, false]));
    expect(standingGrantDigest({ ...stored, terms: { ...stored.terms, scope: { ...stored.terms.scope, ...allFalse } } })).toBe(standingGrantDigest(stored));
    for (const flag of ["reactions", "edits", "deletes", "polls", "dms"] as const) {
      expect(standingGrantDigest({ ...stored, terms: { ...stored.terms, scope: { ...stored.terms.scope, [flag]: true } } }), flag).not.toBe(standingGrantDigest(stored));
    }
  });

  it("covers each action only with its own flag", () => {
    const cases: Array<[Partial<PostFacts>, keyof StandingGrantTerms["scope"], string]> = [
      [{ action: "react" }, "reactions", "react_not_covered"],
      [{ action: "edit", text: "fixed" }, "edits", "edit_not_covered"],
      [{ action: "delete" }, "deletes", "delete_not_covered"],
      [{ action: "dm", text: "hi", personApproved: true }, "dms", "dm_not_covered"],
      [{ poll: true, text: "vote" }, "polls", "poll_not_covered"],
    ];
    for (const [facts, flag, reason] of cases) {
      expect(grantCoversPost({ ...terms(), status: "active" }, post(facts), NOW)).toEqual({ ok: false, reasons: [reason] });
      expect(grantCoversPost({ ...terms({ [flag]: true }), status: "active" }, post(facts), NOW), String(flag)).toEqual({ ok: true });
      // Another flag never covers it.
      const other = flag === "reactions" ? "edits" : "reactions";
      expect(grantCoversPost({ ...terms({ [other]: true }), status: "active" }, post(facts), NOW).ok).toBe(false);
    }
  });

  it("never covers the first message to a person, even with scope.dms (R5)", () => {
    const dms = { ...terms({ dms: true }), status: "active" };
    expect(grantCoversPost(dms, post({ action: "dm", text: "hi" }), NOW)).toEqual({ ok: false, reasons: ["person_first_contact"] });
    expect(grantCoversPost(dms, post({ action: "dm", text: "hi", personApproved: false }), NOW)).toEqual({ ok: false, reasons: ["person_first_contact"] });
    expect(grantCoversPost(dms, post({ action: "dm", text: "hi", personApproved: true }), NOW)).toEqual({ ok: true });
  });

  it("treats true as wider (narrowing-aware) and needs immediate", () => {
    for (const flag of ["reactions", "edits", "deletes", "polls", "dms"] as const) {
      expect(isNarrowing(terms(), terms({ [flag]: true }))).toEqual({ ok: false, error: "grant_widening_refused", fields: [`scope.${flag}`] });
      expect(isNarrowing(terms({ [flag]: true }), terms())).toEqual({ ok: true });
      expect(isNarrowing(terms({ [flag]: true }), terms({ [flag]: false }))).toEqual({ ok: true });
      expect(grantWithinCeiling(terms({ [flag]: true }), ceiling, { now: NOW })).toEqual({ ok: true });
      expect(grantWithinCeiling(terms({ [flag]: true, immediate: false, scheduled: true }), ceiling, { now: NOW })).toMatchObject({ ok: false, fields: [`scope.${flag}`] });
    }
  });
});

describe("payload digest fields (R2)", () => {
  const base: ChannelPayloadDigestInput = {
    workspace: "tenant-community",
    channelId: "ch_1",
    provider: "slack",
    destination: "C0ENG",
    op: "post",
    text: "hello",
    attachments: [],
    campaign: {},
    sendAt: null,
  };

  it("keeps the digest of a plain post (no new field present)", () => {
    // Computed with the Marketplace 0.2.0 code (before routes v2).
    expect(channelPayloadDigest(base)).toBe("efbc9d1a6d769e1db0eaf07281153fbf40484ac4fc8d32de4e22db5a4ca0b2f0");
    expect(channelPayloadDigest({ ...base, mentions: [], remove: false, markup: undefined })).toBe(channelPayloadDigest(base));
  });

  it("changes with every field that changes what is sent", () => {
    const digest = channelPayloadDigest(base);
    const variants: Array<[string, Partial<ChannelPayloadDigestInput>]> = [
      ["op react", { op: "react" }],
      ["op edit", { op: "edit" }],
      ["op delete", { op: "delete" }],
      ["op dm", { op: "dm" }],
      ["op poll", { op: "poll" }],
      ["person id", { personId: "U0ALICE" }],
      ["target", { targetMessageId: "1800000000.000100" }],
      ["text", { text: "hello!" }],
      ["markup", { markup: "markdown-v2" }],
      ["mentions", { mentions: [{ userId: "U0BOB" }] }],
      ["poll", { poll: { question: "When?", options: ["Mon", "Tue"] } }],
      ["attachment", { attachments: [{ sha256: "a".repeat(64), contentType: "image/png", name: "a.png", kind: "image" }] }],
      ["reply", { replyTo: "1700000000.000100" }],
      ["emoji", { emoji: "tada" }],
      ["remove", { emoji: "tada", remove: true }],
    ];
    const seen = new Set([digest]);
    for (const [name, change] of variants) {
      const next = channelPayloadDigest({ ...base, ...change });
      expect(next, name).not.toBe(digest);
      seen.add(next);
    }
    expect(seen.size).toBe(variants.length + 1);
    // Each sub-field binds too.
    const dm = { ...base, op: "dm", personId: "U0ALICE", personName: "Alice" };
    expect(channelPayloadDigest({ ...dm, personId: "U0ALICF" })).not.toBe(channelPayloadDigest(dm));
    expect(channelPayloadDigest({ ...dm, personName: "Alice B" })).not.toBe(channelPayloadDigest(dm));
    const poll = { ...base, op: "poll", poll: { question: "When?", options: ["Mon", "Tue"] } };
    expect(channelPayloadDigest({ ...poll, poll: { question: "When?", options: ["Tue", "Mon"] } })).not.toBe(channelPayloadDigest(poll));
    expect(channelPayloadDigest({ ...poll, poll: { question: "When!", options: ["Mon", "Tue"] } })).not.toBe(channelPayloadDigest(poll));
    expect(channelPayloadDigest({ ...poll, poll: { ...poll.poll, allowsMultiple: true } })).not.toBe(channelPayloadDigest(poll));
    expect(channelPayloadDigest({ ...poll, poll: { ...poll.poll, durationHours: 24 } })).not.toBe(channelPayloadDigest(poll));
    expect(channelPayloadDigest({ ...poll, poll: { ...poll.poll, allowsMultiple: false } })).toBe(channelPayloadDigest(poll));
    const attachment = { sha256: "a".repeat(64), contentType: "image/png", name: "a.png", kind: "image" };
    expect(channelPayloadDigest({ ...base, attachments: [attachment] })).not.toBe(channelPayloadDigest({ ...base, attachments: [{ ...attachment, sha256: "b".repeat(64) }] }));
    expect(channelPayloadDigest({ ...base, attachments: [attachment] })).not.toBe(channelPayloadDigest({ ...base, attachments: [{ ...attachment, kind: "file" }] }));
  });

  it("sorts named mentions by user id, so their order does not matter", () => {
    const one = channelPayloadDigest({ ...base, mentions: [{ userId: "U0BOB" }, { userId: "U0ALICE" }] });
    expect(channelPayloadDigest({ ...base, mentions: [{ userId: "U0ALICE" }, { userId: "U0BOB" }] })).toBe(one);
    expect(channelPayloadDigest({ ...base, mentions: [{ userId: "U0ALICE" }] })).not.toBe(one);
    expect(channelPayloadDigest({ ...base, mentions: [{ userId: "U0ALICE", name: "Alice" }, { userId: "U0BOB" }] })).not.toBe(one);
  });
});

describe("action caps (reactions, edits, deletes: own caps, never the post caps)", () => {
  it("fills defaults, lets the owner only tighten, and keeps old policies on the defaults", () => {
    expect(ceiling.caps.actions).toEqual({ reactionsPerDay: 100, editsPerDay: 20, editMinIntervalSeconds: 30, deletesPerDay: 50 });
    const tighter = validatePolicy({ caps: { actions: { deletesPerDay: 5, editMinIntervalSeconds: 120 } } });
    expect(tighter.ok && tighter.policy.caps.actions).toEqual({ ...DEFAULT_ACTION_CAPS, deletesPerDay: 5, editMinIntervalSeconds: 120 });
    const wider = validatePolicy({ caps: { actions: { deletesPerDay: 51, reactionsPerDay: 101, editsPerDay: 21, editMinIntervalSeconds: 10 } } });
    expect(wider.ok ? [] : wider.errors.map((error) => error.field).sort()).toEqual([
      "caps.actions.deletesPerDay",
      "caps.actions.editMinIntervalSeconds",
      "caps.actions.editsPerDay",
      "caps.actions.reactionsPerDay",
    ]);
    expect(effectiveCaps(null, { perDay: 6, minIntervalSeconds: 600, onePerPhase: true }).actions).toEqual(DEFAULT_ACTION_CAPS);
  });

  it("checks grant action caps against the ceiling and treats them narrowing-aware", () => {
    const withActions = (actions: Record<string, number>) => ({ ...terms(), caps: { ...terms().caps, actions } });
    expect(grantWithinCeiling(withActions({ deletesPerDay: 10, editMinIntervalSeconds: 60 }), ceiling, { now: NOW })).toEqual({ ok: true });
    expect(grantWithinCeiling(withActions({ deletesPerDay: 60, editMinIntervalSeconds: 5 }), ceiling, { now: NOW })).toMatchObject({
      ok: false,
      fields: ["caps.actions.deletesPerDay", "caps.actions.editMinIntervalSeconds"],
    });
    expect(isNarrowing(withActions({ deletesPerDay: 10 }), withActions({ deletesPerDay: 5 }))).toEqual({ ok: true });
    expect(isNarrowing(withActions({ deletesPerDay: 10 }), withActions({ deletesPerDay: 20 }))).toMatchObject({ ok: false, fields: ["caps.actions.deletesPerDay"] });
    expect(isNarrowing(withActions({ deletesPerDay: 10 }), terms())).toMatchObject({ ok: false, fields: ["caps.actions.deletesPerDay"] });
    expect(isNarrowing(withActions({ editMinIntervalSeconds: 60 }), withActions({ editMinIntervalSeconds: 30 }))).toMatchObject({ ok: false, fields: ["caps.actions.editMinIntervalSeconds"] });
    expect(effectiveCaps({ ...terms().caps, actions: { deletesPerDay: 3, editMinIntervalSeconds: 90 } }, ceiling.caps).actions).toEqual({ ...DEFAULT_ACTION_CAPS, deletesPerDay: 3, editMinIntervalSeconds: 90 });
  });
});
