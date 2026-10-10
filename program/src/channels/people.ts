import type { PeoplePolicy, PeoplePolicyMode, PersonRecord } from "./actions-store.js";
import { parsePubkey } from "./providers/nostr.js";

/**
 * People policy (Channels P2 scope 2.2a item 5; review R5). Pure helpers: query normalisation and the policy match.
 * The owner sets one policy per connection: `none` (default: no direct messages), `allowlist` (named people by exact
 * email or handle, and email domains) or `workspace` (anyone the connected workspace or tenant can reach).
 * The agent passes one email or handle and gets back one opaque reference; it never gets a list of members.
 *
 * Allowlist matching (review of PR #51): Slack and Teams match a verified email (or a Teams user principal name) and
 * email domains; every provider also matches an immutable platform id listed by the owner (Slack `U…`, Teams Entra
 * object id, Discord user id, Buzz npub or hex key). Display names, nicknames and handles are user-controlled, so on
 * Discord and Buzz an allowlist matches only the platform id of the person found.
 */
const EMAIL_VERIFIED_PROVIDERS = new Set(["slack", "teams"]);

export const PEOPLE_POLICY_MODES: readonly PeoplePolicyMode[] = ["none", "allowlist", "workspace"];
/** Most finds per agent in any 24 hours (all connections): finds call the platform's directory. */
export const PERSON_LOOKUPS_PER_DAY = 50;
export const PEOPLE_ALLOWLIST_MAX = 500;

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)$/u;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/u;
// A handle: a platform user name, display name, Buzz member name or npub (no @ inside, no control characters).
const HANDLE = /^[^\s@\p{Cc}​-‏‪-‮⁦-⁩﻿]{1,80}$/u;

export type PersonLookup = { kind: "email" | "handle"; value: string };

/** Exactly one of email or handle; lowercased and trimmed (a leading `@` of a handle is dropped). */
export function normalizePersonQuery(input: { email?: unknown; handle?: unknown }): PersonLookup | null {
  const hasEmail = input.email !== undefined;
  const hasHandle = input.handle !== undefined;
  if (hasEmail === hasHandle) return null;
  if (hasEmail) {
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    return email.length <= 254 && EMAIL.test(email) ? { kind: "email", value: email } : null;
  }
  const raw = typeof input.handle === "string" ? input.handle.trim().replace(/^@/u, "") : "";
  return HANDLE.test(raw) ? { kind: "handle", value: raw.toLowerCase() } : null;
}

/** A platform id in comparable form (Buzz: the hex key of an npub or hex; others lowercase). */
export function normalizePlatformId(provider: string, value: string): string {
  if (provider === "buzz") return parsePubkey(value) ?? value.toLowerCase();
  return value.trim().toLowerCase();
}

/**
 * Email or domain match, only for an email the platform verified: Teams (the tenant's own directory) always, Slack only
 * when the profile says `is_email_confirmed` (review of PR #51).
 */
function emailMatches(policy: Pick<PeoplePolicy, "people" | "domains">, provider: string, lookup: PersonLookup, emailVerified: boolean): boolean {
  if (!EMAIL_VERIFIED_PROVIDERS.has(provider) || !lookup.value.includes("@")) return false;
  if (provider === "slack" && !emailVerified) return false;
  if (policy.people.includes(lookup.value)) return true;
  return policy.domains.includes(lookup.value.slice(lookup.value.lastIndexOf("@") + 1));
}

function idMatches(policy: Pick<PeoplePolicy, "people">, provider: string, platformUserId: string): boolean {
  const id = normalizePlatformId(provider, platformUserId);
  return policy.people.some((entry) => !entry.includes("@") && normalizePlatformId(provider, entry) === id);
}

/**
 * Whether the policy lets an agent message this person: `workspace` always; `allowlist` when the found person's
 * platform id is listed, or (Slack, Teams) the verified email or its domain is listed.
 */
export function peoplePolicyAllows(policy: Pick<PeoplePolicy, "mode" | "people" | "domains">, provider: string, lookup: PersonLookup, platformUserId: string, emailVerified = false): boolean {
  if (policy.mode === "workspace") return true;
  if (policy.mode !== "allowlist") return false;
  return idMatches(policy, provider, platformUserId) || emailMatches(policy, provider, lookup, emailVerified);
}

/** The refusal for a person found (at find time and again at send time), or null. */
export function peoplePolicyRefusal(
  policy: PeoplePolicy,
  provider: string,
  lookup: PersonLookup,
  platformUserId: string,
  emailVerified = false,
): { status: number; error: string } | null {
  if (policy.mode === "none") return { status: 403, error: "channel_people_disabled" };
  return peoplePolicyAllows(policy, provider, lookup, platformUserId, emailVerified) ? null : { status: 403, error: "channel_person_not_allowed" };
}

export function personLookupOf(person: Pick<PersonRecord, "lookupKind" | "lookupValue">): PersonLookup {
  return { kind: person.lookupKind, value: person.lookupValue };
}

/** Validates an owner policy update. Allowlist entries are normalised; anything invalid is listed, never dropped. */
export function validatePeoplePolicy(input: { mode: unknown; people?: unknown; domains?: unknown }):
  | { ok: true; mode: PeoplePolicyMode; people: string[]; domains: string[] }
  | { ok: false; errors: Array<{ field: string; message: string }> } {
  const errors: Array<{ field: string; message: string }> = [];
  const mode = PEOPLE_POLICY_MODES.includes(input.mode as PeoplePolicyMode) ? (input.mode as PeoplePolicyMode) : null;
  if (!mode) errors.push({ field: "mode", message: "Must be none, allowlist or workspace." });
  const people: string[] = [];
  const domains: string[] = [];
  const list = (value: unknown, field: string) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > PEOPLE_ALLOWLIST_MAX) {
      errors.push({ field, message: `Must be a list of at most ${PEOPLE_ALLOWLIST_MAX} entries.` });
      return [];
    }
    return value;
  };
  for (const entry of list(input.people, "people")) {
    const raw = typeof entry === "string" ? entry.trim() : "";
    const lookup = raw.includes("@") && !raw.startsWith("@") ? normalizePersonQuery({ email: raw }) : normalizePersonQuery({ handle: raw });
    if (!lookup) errors.push({ field: "people", message: `Invalid email or handle ${String(entry)}.` });
    else if (!people.includes(lookup.value)) people.push(lookup.value);
  }
  for (const entry of list(input.domains, "domains")) {
    const value = typeof entry === "string" ? entry.trim().toLowerCase().replace(/^@/u, "").replace(/\.$/u, "") : "";
    if (!DOMAIN.test(value)) errors.push({ field: "domains", message: `Invalid domain ${String(entry)}.` });
    else if (!domains.includes(value)) domains.push(value);
  }
  if (errors.length > 0 || !mode) return { ok: false, errors };
  return { ok: true, mode, people, domains };
}

/** What the owner sees of a person (never shown to agents as a list). */
export function personOwnerView(person: PersonRecord) {
  return {
    personRef: person.personRef,
    agentId: person.agentId,
    provider: person.provider,
    displayName: person.displayName,
    platformUserId: person.platformUserId,
    lookup: { kind: person.lookupKind, value: person.lookupValue },
    emailVerified: person.emailVerified,
    approved: person.approvedAt !== null,
    approvedAt: person.approvedAt,
    approvedPostId: person.approvedPostId,
    revokedAt: person.revokedAt,
    updatedAt: person.updatedAt,
  };
}
