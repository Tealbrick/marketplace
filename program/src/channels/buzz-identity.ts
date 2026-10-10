import type { SqliteMarketplaceStore } from "../store.js";
import { ownerKeyFingerprint } from "./owner-key.js";
import { checkRelayHost, type RelayLookup } from "./buzz-relay-guard.js";
import { BUZZ_PUBLISHED_KINDS, encodeBuzzCredential, normalizeRelayUrl } from "./providers/buzz.js";
import {
  NIP_OA_MAX_LIFETIME_SECONDS,
  NIP_OA_RENEWAL_REMINDER_SECONDS,
  authPreimage,
  generateSecretKey,
  isBech32With,
  npubEncode,
  parseAuthTag,
  publicKeyOf,
  verifyAuthTag,
  type AuthTagFailure,
} from "./providers/nostr.js";
import type { ChannelCredential, ChannelReadiness } from "./runtime.js";

/**
 * The Buzz connection identity (custody model approved by the Coordinator, 2026-10-10):
 *
 * - Marketplace GENERATES one secp256k1 agent keypair per Buzz connection. The secret key is written only to the
 *   encrypted `connector_secret` store (`channels-buzz` / `agentSecretKey`); it is never shown, exported, logged,
 *   audited or returned, and there is no import. The database backup holds only its ciphertext, useless without
 *   the at-rest key (which is never in a backup). Loss of the store means a new key and a new tag.
 * - The owner screen shows the npub. The owner enters the relay URL (wss://; no default) and pastes the NIP-OA tag
 *   they signed on their own device for the agent key. The tag is verified (BIP-340 by its owner key over the
 *   exact NIP-OA preimage), MUST name the pinned owner Buzz key (`approvals.ownerNostrPubkey`; none set →
 *   `buzz_owner_key_required`), and must end (`created_at<T`) within 90 days. A relay change clears the tag.
 *   Every write is gated by the strict owner gate (buzz-identity-routes.ts). The tag and its SHA-256 are stored; audit records the npub and
 *   the tag digest only.
 * - Rotation generates a new key (the old one is overwritten and gone) and clears the tag (it named the old key).
 *   Revoke clears the tag: Marketplace stops using the identity at once.
 */

export const BUZZ_PLUGIN_ID = "channels-buzz";
export const BUZZ_SECRET_NAME = "agentSecretKey";

export type BuzzTagStatus = "missing" | "valid" | "invalid" | "expired";

export type BuzzIdentityView = {
  key: { present: boolean; npub: string | null; pubkeyHex: string | null; createdAt: string | null };
  relay: { url: string | null; httpBase: string | null };
  authTag: {
    status: BuzzTagStatus;
    reason?: AuthTagFailure | "owner_key_required";
    sha256: string | null;
    ownerNpub: string | null;
    ownerFingerprint: string | null;
    conditions: string | null;
    expiresAt: string | null;
    daysLeft: number | null;
    /** True when the tag ends within 14 days: the owner should sign a new one. */
    renewalDue: boolean;
    setAt: string | null;
    /** Event kinds the stored tag lets Marketplace publish (all of them for a tag without kind clauses). */
    allowsKinds: number[];
  };
  /** From the stored identity alone (no network): what the provider readiness will at best be. */
  readiness: Exclude<ChannelReadiness, "unavailable">;
  /** What the owner signs on their own device: the exact NIP-OA preimage for a 90-day tag, and the bounds. */
  signing: { preimage: string; suggestedConditions: string; maxDays: number; reminderDays: number } | null;
  pinnedOwner: { set: boolean; fingerprint: string | null };
  secretStore: "available" | "unavailable";
};

export type BuzzIdentityResult = { ok: true; view: BuzzIdentityView; changed: boolean } | { ok: false; status: number; error: string; detail?: string };

export type BuzzIdentityDeps = {
  store: SqliteMarketplaceStore;
  organizationId: string;
  now: () => Date;
  /** Test seam: 32 random bytes for a new key (default: the curve library's CSPRNG). */
  randomKey?: () => Uint8Array;
  /** Dev-only private relays (MARKETPLACE_CHANNELS_BUZZ_ALLOW_PRIVATE_RELAY, refused in production). */
  allowPrivateRelay?: boolean;
  /** Test seam: DNS for the relay host. */
  relayLookup?: RelayLookup;
};

export type BuzzIdentity = ReturnType<typeof createBuzzIdentity>;

export function createBuzzIdentity(deps: BuzzIdentityDeps) {
  const { store, organizationId: org } = deps;
  const buzz = store.channels.buzz;
  const nowSeconds = () => Math.floor(deps.now().getTime() / 1000);

  const audit = (eventType: string, actorId: string, metadata: Record<string, unknown>) =>
    store.recordAudit({ workspaceSlug: org, pluginId: BUZZ_PLUGIN_ID, eventType, actorId, metadata: metadata as never });

  const pinnedOwner = (): string | null => {
    try {
      return store.channels.getOwnerKey(org)?.pubkey ?? null;
    } catch {
      return null;
    }
  };

  /** The decrypted agent secret key, server-side only; null when absent or unreadable. Never logged. */
  const readSecretKey = (): { value: string; id: string } | null => {
    try {
      const value = store.readConnectorSecretValues({ workspaceSlug: org, pluginId: BUZZ_PLUGIN_ID })[BUZZ_SECRET_NAME];
      if (!value) return null;
      const id = store.listConnectorSecrets({ workspaceSlug: org, pluginId: BUZZ_PLUGIN_ID }).find((secret) => secret.name === BUZZ_SECRET_NAME)?.id;
      return id ? { value, id } : null;
    } catch {
      return null;
    }
  };

  const tagState = () => {
    const identity = buzz.getIdentity(org);
    if (!identity?.agentPubkey || !identity.authTagJson) return { identity, status: "missing" as BuzzTagStatus };
    // The tag must name the pinned owner Buzz key; without one no tag is valid (fail closed).
    const pin = pinnedOwner();
    if (!pin) return { identity, status: "invalid" as BuzzTagStatus, reason: "owner_key_required" as const };
    const checked = verifyAuthTag({ tag: identity.authTagJson, agentPubkey: identity.agentPubkey, pinnedOwner: pin, nowSeconds: nowSeconds() });
    if (checked.ok) return { identity, status: "valid" as BuzzTagStatus, checked: checked.value };
    return { identity, status: (checked.reason === "auth_tag_expired" ? "expired" : "invalid") as BuzzTagStatus, reason: checked.reason };
  };

  const view = (): BuzzIdentityView => {
    const state = tagState();
    const identity = state.identity;
    const pubkey = identity?.agentPubkey ?? null;
    const endpoint = identity?.relayUrl ? normalizeRelayUrl(identity.relayUrl) : null;
    const expiresAt = identity?.authExpiresAt ?? null;
    const secondsLeft = expiresAt !== null ? expiresAt - nowSeconds() : null;
    const suggested = `created_at<${nowSeconds() + NIP_OA_MAX_LIFETIME_SECONDS}`;
    const pin = pinnedOwner();
    const readiness: BuzzIdentityView["readiness"] =
      !pubkey || !endpoint || state.status === "missing" ? "credential_missing" : state.status === "valid" ? "available" : "credential_invalid";
    return {
      key: { present: pubkey !== null, npub: pubkey ? npubEncode(pubkey) : null, pubkeyHex: pubkey, createdAt: identity?.keyCreatedAt ?? null },
      relay: { url: endpoint?.relayUrl ?? null, httpBase: endpoint?.httpBase ?? null },
      authTag: {
        status: state.status,
        ...("reason" in state && state.reason ? { reason: state.reason } : {}),
        sha256: identity?.authTagSha256 ?? null,
        ownerNpub: identity?.authOwnerPubkey ? npubEncode(identity.authOwnerPubkey) : null,
        ownerFingerprint: identity?.authOwnerPubkey ? ownerKeyFingerprint(identity.authOwnerPubkey) : null,
        conditions: identity?.authConditions ?? null,
        expiresAt: expiresAt !== null ? new Date(expiresAt * 1000).toISOString() : null,
        daysLeft: secondsLeft !== null ? Math.max(0, Math.floor(secondsLeft / 86_400)) : null,
        renewalDue: secondsLeft !== null && secondsLeft < NIP_OA_RENEWAL_REMINDER_SECONDS,
        setAt: identity?.authSetAt ?? null,
        allowsKinds: state.status === "valid" && "checked" in state && state.checked ? BUZZ_PUBLISHED_KINDS.filter((kind) => state.checked!.parsed.kinds.every((allowed) => allowed === kind)) : [],
      },
      readiness,
      signing: pubkey
        ? { preimage: authPreimage(pubkey, suggested), suggestedConditions: suggested, maxDays: NIP_OA_MAX_LIFETIME_SECONDS / 86_400, reminderDays: NIP_OA_RENEWAL_REMINDER_SECONDS / 86_400 }
        : null,
      pinnedOwner: { set: pin !== null, fingerprint: pin ? ownerKeyFingerprint(pin) : null },
      secretStore: store.connectorSecretStoreAvailable() ? "available" : "unavailable",
    };
  };

  /** Generate the first key, or (with `rotate`) replace the key: the old secret is overwritten, the tag cleared. */
  const generateKey = (input: { rotate: boolean; actor: string }): BuzzIdentityResult => {
    if (!store.connectorSecretStoreAvailable()) return { ok: false, status: 503, error: "connector_secret_store_unavailable" };
    const current = buzz.getIdentity(org);
    const hadKey = Boolean(current?.agentPubkey && readSecretKey());
    if (hadKey && !input.rotate) return { ok: false, status: 409, error: "buzz_key_exists", detail: "rotate the key to replace it" };
    if (!hadKey && input.rotate) return { ok: false, status: 409, error: "buzz_key_missing" };
    const secretKey = generateSecretKey(deps.randomKey);
    const pubkey = publicKeyOf(secretKey);
    if (!pubkey) return { ok: false, status: 500, error: "buzz_key_generation_failed" };
    store.putConnectorSecret({ workspaceSlug: org, pluginId: BUZZ_PLUGIN_ID, name: BUZZ_SECRET_NAME, value: secretKey });
    const previousTag = current?.authTagSha256 ?? null;
    buzz.setAgentKey({ workspaceSlug: org, agentPubkey: pubkey, actor: input.actor, now: deps.now() });
    // The new key is not a member of the old bridge channels: every route needs the owner's confirmation again.
    const retired = hadKey ? buzz.unconfirmRoutes(org, input.actor, deps.now(), "key_rotated") : { routes: 0, retiredGroups: [] };
    audit(hadKey ? "marketplace.channels.buzz.key_rotated" : "marketplace.channels.buzz.key_generated", input.actor, {
      npub: npubEncode(pubkey),
      ...(hadKey ? { pausedRoutes: retired.routes, retiredGroups: retired.retiredGroups } : {}),
      ...(hadKey && current?.agentPubkey ? { previousNpub: npubEncode(current.agentPubkey) } : {}),
      ...(previousTag ? { clearedTagSha256: previousTag } : {}),
    });
    return { ok: true, view: view(), changed: true };
  };

  /** Owner settings: the relay URL (wss://, owner-entered) and/or the NIP-OA tag for the current agent key. */
  const update = async (input: { relayUrl?: string; authTag?: unknown; actor: string }): Promise<BuzzIdentityResult> => {
    let changed = false;
    if (input.relayUrl !== undefined) {
      const endpoint = normalizeRelayUrl(input.relayUrl);
      if (!endpoint) return { ok: false, status: 422, error: "buzz_relay_url_invalid", detail: "enter the relay as wss://host (no path, query or user info)" };
      // Egress rules: every resolved address must be public (unless the dev-only flag is on); re-checked at connect.
      const allowed = await checkRelayHost(endpoint.host.replace(/:\d+$/u, ""), { allowPrivate: deps.allowPrivateRelay ?? false, ...(deps.relayLookup ? { lookup: deps.relayLookup } : {}) });
      if (!allowed.ok) return { ok: false, status: 422, error: `buzz_${allowed.reason}`, detail: "the relay must resolve only to public addresses" };
      const current = buzz.getIdentity(org);
      const previous = current?.relayUrl ?? null;
      if (previous !== endpoint.relayUrl) {
        buzz.setRelayUrl({ workspaceSlug: org, relayUrl: endpoint.relayUrl, actor: input.actor, now: deps.now() });
        // A changed relay forces re-confirmation: the tag is cleared (readiness credential_missing until the owner
        // pastes a tag again) and the bridge stays paused for every route until the owner saves it again.
        const clearedTag = previous !== null && current?.authTagSha256 ? current.authTagSha256 : null;
        if (clearedTag) buzz.clearAuthTag({ workspaceSlug: org, actor: input.actor, now: deps.now() });
        const retired = previous !== null ? buzz.unconfirmRoutes(org, input.actor, deps.now(), "relay_changed") : { routes: 0, retiredGroups: [] };
        audit("marketplace.channels.buzz.relay_changed", input.actor, {
          oldRelayHost: previous ? normalizeRelayUrl(previous)?.host ?? null : null,
          newRelayHost: endpoint.host,
          actor: input.actor,
          pausedRoutes: retired.routes,
          retiredGroups: retired.retiredGroups,
          ...(clearedTag ? { clearedTagSha256: clearedTag } : {}),
        });
        changed = true;
      }
    }
    if (input.authTag !== undefined) {
      const identity = buzz.getIdentity(org);
      if (!identity?.agentPubkey) return { ok: false, status: 409, error: "buzz_key_missing", detail: "generate the agent key first" };
      if (typeof input.authTag === "string" && (isBech32With(input.authTag.trim(), "nsec") || /nsec1/iu.test(input.authTag))) {
        // A secret key pasted by mistake is refused and never stored or echoed.
        return { ok: false, status: 422, error: "buzz_auth_tag_malformed", detail: "paste the auth tag, never a secret key" };
      }
      if (!parseAuthTag(input.authTag)) return { ok: false, status: 422, error: "buzz_auth_tag_malformed", detail: 'paste the tag as ["auth", "<owner hex>", "<conditions>", "<signature hex>"]' };
      // The tag's owner key MUST be the pinned owner Buzz key (approvals.ownerNostrPubkey); none set → refused.
      const pin = pinnedOwner();
      if (!pin) return { ok: false, status: 409, error: "buzz_owner_key_required", detail: "set the owner Buzz key (approvals.ownerNostrPubkey) first" };
      const checked = verifyAuthTag({ tag: input.authTag, agentPubkey: identity.agentPubkey, pinnedOwner: pin, nowSeconds: nowSeconds() });
      if (!checked.ok) return { ok: false, status: 422, error: `buzz_${checked.reason}` };
      // NIP-OA kind clauses are conjunctive: a tag with any kind= clause cannot cover the kinds Marketplace publishes.
      if (checked.value.parsed.kinds.length > 0) {
        return { ok: false, status: 422, error: "buzz_auth_tag_kinds_too_narrow", detail: `the tag must not limit kinds; Marketplace publishes kinds ${BUZZ_PUBLISHED_KINDS.join(", ")}` };
      }
      if (identity.authTagSha256 !== checked.value.sha256) {
        buzz.setAuthTag({
          workspaceSlug: org,
          tagJson: checked.value.json,
          sha256: checked.value.sha256,
          ownerPubkey: checked.value.ownerPubkey,
          conditions: checked.value.conditions,
          expiresAt: checked.value.expiresAt,
          actor: input.actor,
          now: deps.now(),
        });
        audit("marketplace.channels.buzz.auth_tag_set", input.actor, {
          npub: npubEncode(identity.agentPubkey),
          tagSha256: checked.value.sha256,
          ownerFingerprint: ownerKeyFingerprint(checked.value.ownerPubkey),
          expiresAt: new Date(checked.value.expiresAt * 1000).toISOString(),
        });
        changed = true;
      }
    }
    return { ok: true, view: view(), changed };
  };

  /** Revoke: clear the tag. Marketplace stops publishing and receiving with the identity at once. */
  const revokeTag = (actor: string): BuzzIdentityResult => {
    const identity = buzz.getIdentity(org);
    if (!identity?.authTagSha256) return { ok: true, view: view(), changed: false };
    buzz.clearAuthTag({ workspaceSlug: org, actor, now: deps.now() });
    audit("marketplace.channels.buzz.auth_tag_revoked", actor, {
      ...(identity.agentPubkey ? { npub: npubEncode(identity.agentPubkey) } : {}),
      tagSha256: identity.authTagSha256,
    });
    return { ok: true, view: view(), changed: true };
  };

  /**
   * The runtime credential: secret key + relay URL + tag, or null while any of them is missing (readiness
   * `credential_missing`). A stored tag that no longer verifies is still passed (the adapter and `readiness()`
   * answer `credential_invalid`). A secret that does not match the stored public key counts as missing.
   */
  const credential = (): ChannelCredential | null => {
    const identity = buzz.getIdentity(org);
    if (!identity?.agentPubkey || !identity.relayUrl || !identity.authTagJson) return null;
    const secret = readSecretKey();
    if (!secret || publicKeyOf(secret.value) !== identity.agentPubkey) return null;
    const tag = parseAuthTag(identity.authTagJson);
    if (!tag) return null;
    return {
      value: encodeBuzzCredential({ secretKey: secret.value, relayUrl: identity.relayUrl, authTag: tag }),
      ref: `marketplace-secret:${secret.id}`,
      secrets: [secret.value],
    };
  };

  /** Local readiness (no network): missing parts, then the tag against the pinned owner key and the clock. */
  const readiness = (): Exclude<ChannelReadiness, "unavailable"> => view().readiness;

  return {
    view,
    generateKey,
    update,
    revokeTag,
    credential,
    readiness,
    relayUrl: (): string | null => buzz.getIdentity(org)?.relayUrl ?? null,
    agentPubkey: (): string | null => buzz.getIdentity(org)?.agentPubkey ?? null,
    hasKey: (): boolean => Boolean(buzz.getIdentity(org)?.agentPubkey),
  };
}
