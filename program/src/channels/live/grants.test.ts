import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { signTestEvent } from "../providers/buzz-test-relay.js";
import { publicKeyOf } from "../providers/nostr.js";
import type { ChannelRecord } from "../store.js";
import { createLiveGrantService, liveGrantDescription, liveGrantIntegrityProblem, liveGrantOf, type LiveOwnerBinding } from "./grants.js";
import { LiveStore, migrateLiveTables } from "./store.js";

// Unit level: paths of the live-session grant service that the app tests cannot time (a key change DURING proof
// verification) and the integrity template itself.

const OWNER_SECRET = "0000000000000000000000000000000000000000000000000000000000000007";
const OWNER = publicKeyOf(OWNER_SECRET)!;
const ORG = "tenant-unit";

function harness(bindings: LiveOwnerBinding[]) {
  const db = new DatabaseSync(":memory:");
  migrateLiveTables(db);
  const live = new LiveStore(db);
  const parent = randomUUID();
  const channel = { id: "chn-1", workspaceSlug: ORG, slug: "community", label: "Community", provider: "buzz", status: "active", destination: { type: "channel", externalId: parent, title: "community" } } as unknown as ChannelRecord;
  const used = new Set<string>();
  let calls = 0;
  const service = createLiveGrantService({
    live,
    organizationId: ORG,
    now: () => new Date(),
    consentActive: () => true,
    channel: (id) => (id === channel.id ? channel : null),
    // Each read returns the next binding (the last one repeats).
    ownerBinding: async () => bindings[Math.min(calls++, bindings.length - 1)]!,
    markUsed: (id) => (used.has(id) ? false : (used.add(id), true)),
    audit: () => undefined,
    auditControl: () => undefined,
  });
  const proposed = service.propose({
    channel,
    agentId: "agent-1",
    consentRowId: "consent-1",
    proposal: { modes: { listen: true }, maxSessionMinutes: 10, maxDayMinutes: 20, costCap: { providerMinutes: 30 }, topic: "Unit call", expires: new Date(Date.now() + 86_400_000).toISOString() },
  });
  if (!proposed.ok) throw new Error(proposed.error);
  return { live, service, channel, parent, record: proposed.grant, used };
}

const portalUnbound = { ok: false as const, status: 503, error: "approval_owner_unbound" };
const nostrBinding = (fingerprint: string): LiveOwnerBinding => ({ nostr: { ok: true, pubkey: OWNER, fingerprint, setAtMs: Date.now() - 60_000 }, portal: portalUnbound });

describe("live grant service", () => {
  it("refuses a Buzz approval when the owner key changes while the proof is verified (approval_owner_key_changed)", async () => {
    const h = harness([nostrBinding("aaaaaaaaaaaaaaaa"), nostrBinding("bbbbbbbbbbbbbbbb")]);
    const event = signTestEvent(OWNER_SECRET, { kind: 9, created_at: Math.floor(Date.now() / 1000), tags: [["h", h.parent]], content: `approve grant ${h.record.digest.slice(0, 32)}` });
    const outcome = await h.service.approveWithProof({ record: h.record, proof: { proof: "nostr", event: event as unknown as Record<string, unknown>, channel: h.parent } });
    expect(outcome).toMatchObject({ ok: false, status: 409, error: "approval_owner_key_changed" });
    expect(h.live.getGrant(ORG, h.record.id)!.status).toBe("proposed");
  });

  it("accepts the same proof when the key stays the same", async () => {
    const h = harness([nostrBinding("aaaaaaaaaaaaaaaa")]);
    const event = signTestEvent(OWNER_SECRET, { kind: 9, created_at: Math.floor(Date.now() / 1000), tags: [["h", h.parent]], content: `approve grant ${h.record.digest.slice(0, 32)}` });
    const outcome = await h.service.approveWithProof({ record: h.record, proof: { proof: "nostr", event: event as unknown as Record<string, unknown>, channel: h.parent } });
    expect(outcome).toMatchObject({ ok: true, grant: { status: "active", approvalSource: "nostr" } });
  });

  it("binds the canonical grant to the record's agent, channel slug, Buzz conversation and approval channel", () => {
    const h = harness([nostrBinding("aaaaaaaaaaaaaaaa")]);
    const grant = liveGrantOf(h.record)!;
    expect(grant.description).toBe(liveGrantDescription("agent-1", "community"));
    expect(liveGrantIntegrityProblem(h.record, grant, h.channel)).toBeNull();
    expect(liveGrantIntegrityProblem({ ...h.record, agentId: "agent-2" }, grant, h.channel)).toBe("description");
    expect(liveGrantIntegrityProblem(h.record, grant, { ...h.channel, slug: "other" })).toBe("description");
    expect(liveGrantIntegrityProblem({ ...h.record, id: "live-0000000000000000" }, grant, h.channel)).toBe("id");
    expect(liveGrantIntegrityProblem(h.record, grant, { ...h.channel, destination: { ...h.channel.destination, externalId: randomUUID() } })).toBe("target");
    expect(liveGrantIntegrityProblem({ ...h.record, approvalChannel: randomUUID() }, grant, h.channel)).toBe("approvalChannel");
    expect(h.service.usable({ ...h.record, status: "active", approvedDigest: h.record.digest, agentId: "agent-2" })).toEqual({ ok: false, reason: "grant_integrity_failed" });
  });
});
