# Teal Brick miniapp contract

Marketplace follows the Teal Brick miniapp contract (`tealbrick.miniapp/v1`,
kit `@tealbrick/contract` pinned at `0.1.0-alpha.8`). The manifest is
`tealbrick.app.json` at the repository root. It is validated at start-up and
served at `/.well-known/tealbrick/manifest`. Validate it in CI with:

```sh
npx -y @tealbrick/contract@0.1.0-alpha.8 validate tealbrick.app.json
```

The Portal launch hand-off, the runtime lease receiver, connector secret
encryption (`MARKETPLACE_HANDOFF_ENCRYPTION_KEY`) and operator sessions work as
before. The claim at `runtime.claim` (`/.well-known/tealbrick/claim`) is the
contract kit's manifest claim; the legacy Marketplace claim stays at
`/api/tealbrick/claim`. See [Claim](#claim) and `docs/instance-claim.md`.

## Kind

`kind` is `suite`. A `bridge` wraps one open-source upstream that runs as a
pinned service beside the app. Marketplace pins none: Composio is a hosted
service reached over its API with the account key, and Nango and Activepieces
are optional external adapters that Marketplace does not run or version-pin.
If one runtime is pinned as a sidecar later, the manifest can move to `bridge`
with that `upstream`.

## Operations

| Audience | Operation | Route |
| --- | --- | --- |
| agent | `marketplace.consents.list` | `GET /api/marketplace/v1/agent/consents` |
| agent | `marketplace.tools.call` | `POST /api/marketplace/v1/agent/tools/call` |
| owner | `marketplace.consents.request` / `.redeem` / `.revoke` | `/api/marketplace/v1/agent/grants/request`, `/redeem`, `/api/marketplace/agent/grants/{grantId}/revoke` |
| owner | `marketplace.connections.connect` | `POST /api/marketplace/plugins/{pluginId}/connection` |
| owner | `marketplace.plugins.install` / `.uninstall` / `.register` / `.unregister`, `marketplace.catalog.import` | `/api/marketplace/plugins/{pluginId}/...`, `/api/marketplace/catalog/composio/import` |
| owner | `marketplace.settings.get` / `.update` / `.clear` | `/api/settings/providers/composio` |
| owner | `marketplace.approvals.list` / `.get` / `.approve` / `.deny` | `/api/marketplace/company-box/approvals...` |
| agent | `marketplace.approvals.resolve` | `POST /api/marketplace/v1/agent/approvals/{approvalId}/resolve` |
| owner | `marketplace.approval-owner-key.get` / `.update` / `.clear` | `GET` / `PUT` / `DELETE /api/marketplace/approvals/owner-key` (see [Owner Buzz key](#owner-buzz-key-v1)) |
| agent | Channels: `marketplace.channels.*`, `marketplace.channel-*` | see [Channels](#channels) |
| owner | Channels: `marketplace.channels.*`, `marketplace.channel-*` | see [Channels](#channels) |

Owner operations are for the owner's UI session (or the internal service
bearer). A Portal app grant never reaches them: the answer is `403
{"error":"operation_owner_only"}`. A route that is not declared answers `403
{"error":"operation_unknown"}`.

### `marketplace.consents.list`

Returns only the calling agent's active consents:
`{ok, schema, consents: [{consentId, toolkit, actions, state}]}`. `toolkit` is
the Marketplace connector id (`pluginId`). One consent covers one action, so
`actions` has one entry. It carries no credential and no account id.

### `marketplace.tools.call`

Body `{consentId, toolkit, action, arguments}` and an `Idempotency-Key` header
(8 to 100 URL-safe characters). The contract requires `idempotency: "required"`
for any operation that creates, so the key is mandatory (`400
idempotency_key_required`). A repeat of the same key and body returns the
first answer with `replayed: true`; the same key with a different body is `409
runtime_idempotency_conflict`.

Checks, in order: grant (`tbag_`) and operation; body shape; key; `arguments`
at most 12 KiB (`413 arguments_too_large`; the whole body is capped at 16 KiB).
Then the consent must exist, be active-for-this-caller, and belong to this
agent, workspace and deployment, else `404 consent_not_found` (the same answer
for an unknown and a foreign id, so ids do not leak). A wrong `toolkit`, a
wrong `action` or a revoked consent is `403 consent_mismatch` with a `reason`.

The call then runs through the same code as the Portal runtime receiver
(`/api/marketplace/v1/runtime/composio/execute`): connection, capability
binding, published action, Rules or owner approval, idempotent dispatch, usage
ledger and audit. Only the proof of the consent differs (a Portal lease there,
a Portal app grant here). The provider result is untrusted data: the answer is
JSON with `resultTrust: "untrusted-provider-data"`, credential-like keys are
redacted, the result is capped at 64 KiB, and the response carries
`x-content-type-options: nosniff` and a `default-src 'none'` policy.

## Claim

`runtime.claim` is `/.well-known/tealbrick/claim`. It is served by the kit's
claim handler (`createContractHandler` with `identity`, `claim` and
`claimPaths: ["/.well-known/tealbrick/claim"]`), mounted only for that path
(`program/src/manifest-claim.ts`):

* `GET` → `{instanceId, publicJwk}`, with the answer header
  `x-tealbrick-contract: 0.1.0-alpha.8` (the kit version). Portal Core sends
  `ownerSubject` only when this header says alpha.7 or newer.
* `POST {portalIssuer, nonce, companyId, jwksUri?, grantKids?, ownerSubject?,
  claimIssuedAt?}` → `{proof}`, an EdDSA `tealbrick-app-claim` v1 JWT with
  exactly `typ`, `version`, `aud` (= `portalIssuer`), `nonce`, `instanceId`,
  `companyId`, `iat`, `exp` (`exp - iat` = 300 s), plus `ownerSubject` and
  `claimIssuedAt` only when the claim had them.
* Credential: a custom kit `CredentialVerifier` that applies the legacy claim
  rule (internal token or `TEALBRICK_INSTANCE_TOKEN` as Bearer or
  `x-knowledge-instance-token`, or the Portal instance proof in
  `x-tealbrick-instance-proof`, constant time). The kit refuses any request
  with `Origin` or `Cookie`.
* `companyId` must equal `MARKETPLACE_ORGANIZATION_ID` (else the Portal
  workspace binding); the issuer must equal the configured Portal issuer
  (`claim.issuers`).
* The claim key and instance id are the ones in
  `instance-claim-identity.json`, shared with the legacy route. The binding, the
  grant trust anchors and the owner pin (`ownerSubject`, `ownerPinnedAt`) are
  kept in `instance-claim-binding.json` (the kit's `ClaimStore`), ready for
  `l2GrantOptionsFromClaim` and the owner approval check.
* Owner pin (contract alpha.7): `ownerSubject` (`tealbrick-user:<owner id>`)
  needs `claimIssuedAt`. The kit orders claims by `claimIssuedAt`: an older
  claim is `409 stale_claim` and writes nothing, a newer claim replaces the
  owner, and a newer claim without `ownerSubject` clears it. `ownerPinnedAt`
  keeps the high-water mark. The legacy route does not take `ownerSubject`.

## Control endpoints

`GET /healthz` (`{ok, app, version, major, ...}`), and under
`/.well-known/tealbrick/`: `manifest`, `status`, `settings`, `companions`,
`claim` (manifest protocol; the legacy protocol is at `/api/tealbrick/claim`,
same identity) and `guidance/1`.
`status`, `settings` and `companions` accept the Portal-held instance
credential (`Authorization: Bearer`, `x-knowledge-instance-token` or
`x-tealbrick-instance-proof`). `status` and `settings` also accept the 5-minute
settings bearer from a Portal launch, or a live emergency session.

Settings: `composio.baseUrl` and `composio.defaultUserId` are written here
(`composio.baseUrl` must be an `https://*.composio.dev` address). The Composio
key (`composio.apiKey`) is account-sourced and arrives as `COMPOSIO_API_KEY`;
it is reported as presence only.

## Grants

Two agent paths, side by side:

* Portal runtime lease on `/api/marketplace/v1/runtime/composio/execute`.
* Portal app grant (`Authorization: Bearer tbag_...`, contract L1, wire
  `app-grant-v1`) on the two agent operations. It needs the Portal issuer,
  deployment id and instance proof; without them the answer is `503
  portal_unconfigured`.

## Launch and emergency access

`POST /auth/launch` keeps its behaviour and also accepts `route` (one of the
manifest routes, checked before the ticket is spent) and `purpose=settings`
(Portal's server-side settings relay: a 5-minute settings bearer only, no
session). A launch into `/?view=settings` also hands the bearer over in the URL
fragment.

If `TEALBRICK_EMERGENCY_CODE` is set (at least 128 bits), `POST /auth/emergency`
signs the owner in for 15 minutes without Portal, rate-limited per client
(`X-Forwarded-For`, one trusted proxy) and audited without the code. The UI
shows a banner. Rotate by changing the variable and redeploying.

## Configuration

`TEALBRICK_TENANT_ID` must equal `MARKETPLACE_ORGANIZATION_ID` (or
`MARKETPLACE_PORTAL_WORKSPACE_ID`); a mismatch stops start-up. It is the
binding when neither of the others is set. `TEALBRICK_PORTAL_URL`,
`TEALBRICK_DEPLOYMENT_ID`, `TEALBRICK_PORTAL_ORG_ID` and
`TEALBRICK_PORTAL_INSTANCE_PROOF` are accepted beside the `MARKETPLACE_PORTAL_*`
names (a conflict stops start-up). `TEALBRICK_INSTANCE_TOKEN` is accepted
beside `MARKETPLACE_INTERNAL_AUTH_TOKEN` as an instance credential.

## Rules companion

Rules is an optional companion (`enhanced-by`). `GET .../companions` reports
it bound only when `RULES_BASE_URL` and `RULES_INTERNAL_AUTH_TOKEN` are set.
Without Rules, Marketplace stays in owner approval mode.

## Channels

Spec: `docs/channels-spec.md` v0.2 (branch `claude/channels-spec`). A channel is
an owner-registered outward destination (P1: a Telegram chat or a Discord
channel; P2: a Slack channel, a Microsoft Teams channel or chat). Every send goes through `executeConsentedCall` (C1): the shared head
verifies the Portal consent, the channel path resolves the post (§6 3a channel
and capability, 3b content, 3c authority, 3d caps), and the shared tail runs
governance, the `channel-native` execution target, idempotency
(`marketplace_runtime_operation`), the usage ledger (shapes only) and audit
(metadata and the payload SHA-256 only). Receipt text lives only in
`channel_receipt`.

Contract alpha.3 operation ids are exactly `<app>.<resource>.<verb>`, so the
spec's sub-resource ids use a hyphenated resource
(`marketplace.channels.grants.propose` is `marketplace.channel-grants.propose`).

### Agent operations (Portal app grant, `tbag_`)

| Operation | Route | Effects | Idempotency |
| --- | --- | --- | --- |
| `marketplace.channels.list` | `GET /api/marketplace/v1/agent/channels` | read-only | none |
| `marketplace.channels.get` | `GET /api/marketplace/v1/agent/channels/{channelId}` | read-only | none |
| `marketplace.channel-attachments.upload` | `POST /api/marketplace/v1/agent/channels/attachments?name=<file>` | writes-app-state | required |
| `marketplace.channels.post` | `POST /api/marketplace/v1/agent/channels/{channelId}/posts` | external-effects (`approvalAuthority: "app"`, `appHold`) | required |
| `marketplace.channels.schedule` | `POST /api/marketplace/v1/agent/channels/{channelId}/scheduled` | external-effects (`approvalAuthority: "app"`, `appHold`) | required |
| `marketplace.channel-scheduled.cancel` | `POST /api/marketplace/v1/agent/channels/{channelId}/scheduled/{postId}/cancel` | writes-app-state | supported |
| `marketplace.channel-receipts.list` | `GET /api/marketplace/v1/agent/channels/receipts` | read-only | none |
| `marketplace.channel-grants.list` | `GET /api/marketplace/v1/agent/channels/grants` | read-only | none |
| `marketplace.channel-grants.propose` | `POST /api/marketplace/v1/agent/channels/{channelId}/grants` | writes-app-state | required |
| `marketplace.channel-grants.narrow` | `POST /api/marketplace/v1/agent/channels/grants/{grantId}/narrow` | writes-app-state | required |
| `marketplace.channel-grants.withdraw` | `POST /api/marketplace/v1/agent/channels/grants/{grantId}/withdraw` | writes-app-state | supported |
| `marketplace.channels.inbound` | `GET /api/marketplace/v1/agent/channels/inbound?limit=&before=` | read-only | none |
| `marketplace.channels.reply` | `POST /api/marketplace/v1/agent/channels/inbound/{eventId}/reply` | external-effects (`approvalAuthority: "app"`, `appHold`) | required |
| `marketplace.channel-messages.react` | `POST /api/marketplace/v1/agent/channels/{channelId}/messages/{messageId}/reactions` `{emoji, remove?}` | external-effects (`approvalAuthority: "app"`, `appHold`) | required |
| `marketplace.channel-messages.edit` | `PATCH /api/marketplace/v1/agent/channels/{channelId}/messages/{messageId}` `{text}` | external-effects (`approvalAuthority: "app"`, `appHold`) | required |
| `marketplace.channel-messages.delete` | `DELETE /api/marketplace/v1/agent/channels/{channelId}/messages/{messageId}` | external-effects (`approvalAuthority: "app"`, `appHold`) | required |
| `marketplace.channel-people.find` | `POST /api/marketplace/v1/agent/channels/{channelId}/people/find` `{email}` or `{handle}` → `{person: {personRef, displayName, approved}}` | writes-app-state | required |
| `marketplace.channel-people.message` | `POST /api/marketplace/v1/agent/channels/{channelId}/people/{personRef}/messages` `{text, attachments?}` | external-effects (`approvalAuthority: "app"`, `appHold`) | required |
| `marketplace.channel-live-grants.list` | `GET /api/marketplace/v1/agent/channels/live-grants` | read-only | none |
| `marketplace.channel-live-grants.propose` | `POST /api/marketplace/v1/agent/channels/{channelId}/live-grants` (see [Live sessions](#live-sessions-channels-p2)) | writes-app-state | required |
| `marketplace.channel-live-grants.narrow` | `POST /api/marketplace/v1/agent/channels/live-grants/{grantId}/narrow` | writes-app-state | required |
| `marketplace.channel-live-grants.withdraw` | `POST /api/marketplace/v1/agent/channels/live-grants/{grantId}/withdraw` | writes-app-state | supported |
| `marketplace.channel-live-grants.resolve` | `POST /api/marketplace/v1/agent/channels/live-grants/{grantId}/resolve` `{approvalId: grantId, proof}` | writes-app-state | required |
| `marketplace.channel-live-grants.command` | `POST /api/marketplace/v1/agent/channels/live-grants/commands` `{event}` | writes-app-state | supported |
| `marketplace.channel-live.join` | `POST /api/marketplace/v1/agent/channels/{channelId}/live/sessions` `{grantId, huddleId, modes}` | external-effects | required |
| `marketplace.channel-live.leave` | `POST /api/marketplace/v1/agent/channels/{channelId}/live/sessions/{sessionId}/leave` | external-effects | supported |
| `marketplace.channel-live.speak` | `POST /api/marketplace/v1/agent/channels/{channelId}/live/sessions/{sessionId}/speak` `{attachmentId}` or `{text, voice?}` | external-effects (`approvalAuthority: "app"`, `appHold`) | required |
| `marketplace.channel-live.transcript` | `GET /api/marketplace/v1/agent/channels/{channelId}/live/sessions/{sessionId}/transcript` | read-only | none |
| `marketplace.approvals.resolve` | `POST /api/marketplace/v1/agent/approvals/{approvalId}/resolve` | writes-app-state | required (`resolve.<approvalId>.<decision>`) |

Consent: a Portal v1.4 class grant `{pluginId: channels-<provider>, accountId:
<connectionId>, resourceKind: <provider>.connected-account, resourceRef:
account:<connectionId>, grantClass, actionGroup: channel:<slug>}`. `outward`
is needed to post, schedule, cancel, upload, propose, react, edit, delete, find people and send direct messages; `read` suffices for
list, get, receipts and grants. A channel without such a consent for the
caller answers `404 channel_not_found`, the same as an unknown channel.
Marketplace requires the `actionGroup` (a whole-connection class consent does
not reach channels in P1).

**Capabilities answer shape changed (`channelCapabilities: 2`).** The
`capabilities` object in `channels.list` and `channels.get` (and in the owner
`browse` answer) now uses the v2 vocabulary: `mentions` is an object
`{users, broadcast: "suppressed"}` (was the string `"suppressed"`), `thread` is
`{replies, topics, forum}`, `reactions` is `{add, remove, custom}`, `edit` and
`delete` are `{own}`, and `dm`, `canvas`, `presence`, `ephemeral`, `live` and
`inbound {mode, dedupe}` are new. There is no manifest or contract version bump:
agent consumers must branch on `channelCapabilities` (absent or `1` is the v1
shape). The answer is **effective**, not the adapter's raw declaration: it is
the declaration intersected with `AGENT_WIRED_FEATURES`
(`program/src/channels/providers/capabilities.ts`), the closed set of features
an agent operation can use today (the attachment kinds, forum topics as
destinations, `inbound` for `marketplace.channels.inbound`,
`thread.replies` for `marketplace.channels.reply`, the only operation that
replies in a thread, and, since routes v2, `reactions.add|remove|custom`,
`edit`, `delete`, `dm`, `poll`, `mentions.users` and `markup.markdown-v2`; see
[Routes v2](#routes-v2-channels-p2)). A feature an adapter can do but no route performs yet reads as
`false`, `{own: false}` or `{mode: "none"}`, and `markupOptions` lists only
the markups whose `markup.<name>` feature is wired. A later release that ships an
operation adds its feature to that set in the same change.

Post body: `{text, attachments?: [{attachmentId, kind, transcript?}],
campaign?: {ref?, phase?}, mentions?: [userId | {userId, name?}], markup?,
poll?: {question, options, allowsMultiple?, durationHours?}}` (`schedule` adds
`sendAt`, now + 60 s to now + 30 days, and takes no `poll`; see
[Routes v2](#routes-v2-channels-p2) for `mentions`, `markup` and `poll`). `kind` is `image|file|audio|voice|video` and must be declared by the
channel's provider. Declared fallbacks (Slack voice → audio + `Transcript:`
line) are applied before the content rules and before the digest, so a
transcript passes the same deny patterns and the owner approves exactly what is
sent. A Discord voice note is native: its digest also covers the
`voiceMessage` metadata (`flags` 8192, `durationSecs`, `waveform`) computed
from the OGG file before approval; a file that is not a usable Ogg/Opus stream
is refused `422 channel_voice_invalid`, and a voice note with other
attachments `422 channel_voice_alone`. Attachments must be the caller's own uploads; unknown or foreign ids are
refused, never dropped.

Answers:

* `200 {ok: true, schema: 1, traceId, usageId, receipt}` (a replay of the same
  key adds `replayed: true`). Receipt: `{resultIds, resultUrls, status,
  detail, channelId, postId, digest, authority, approvedAt, sentAt, provider,
  fallback?}`; `status` is `sent|failed|uncertain|pending|skipped|cancelled|
  expired`; `authority` is `grant:<id>`, `approval:<id>` or `owner-test`. A
  scheduled post answers `pending`.
* `202 {error: "approval_pending", approvalId, digest, expiresAt,
  payloadView: {canonical, files: [{name, sha256, contentType}]}}`, exactly
  the contract `approvalPendingSchema` (strict: no other key; `digest =
  sha256(payloadView.canonical)`). The post id is in the `Tealbrick-Post-Id`
  response header (held and scheduled posts) and the trace id in `X-Trace-Id`.
  The manifest output schema `ChannelPostResult` declares the same strict
  body. No grant covers the post, so it waits for the owner in the existing
  approvals queue. A new hold whose first 32 hex of digest equal those of
  another live (pending, resolving, executing) hold of the workspace is `409
  channel_digest_prefix_collision` (nothing is held or consumed; change the
  text and retry), because a Buzz reply approves by that prefix. Retry with the same key; after the owner approves,
  the post is sent exactly once and the retry returns its receipt. A changed
  payload needs a new approval. A scheduled hold's approval expires at
  `sendAt`.
* `502 channel_send_failed` (nothing was delivered; does not count) or `502
  channel_send_uncertain` (may have been delivered; counts and blocks the key
  until the owner resolves it), both with the receipt.

Errors: `400 idempotency_key_required | validation_failed`, `403
channel_outward_consent_required | approval_denied`, `404 channel_not_found |
channel_attachment_not_found | channel_post_not_found | grant_not_found`, `409
channel_idempotency_conflict | channel_not_active |
channel_connection_unavailable | channel_digest_mismatch |
channel_post_uncertain | channel_post_in_progress | channel_post_<status> |
standing_grants_disabled | approval_already_resolved | approval_proof_reused |
approval_owner_key_changed | approval_proof_prefix_too_short |
approval_proof_ambiguous | channel_digest_prefix_collision`,
`410 approval_expired`, `413 channel_attachment_too_large |
channel_payload_view_too_large`, `415 channel_attachment_type_invalid`, `422
channel_capability_unavailable | channel_text_too_long |
channel_content_denied | channel_event_unconfirmed | channel_outside_window |
channel_file_type_not_allowed | channel_file_too_large |
channel_too_many_files | channel_voice_transcript_required |
channel_send_at_invalid | grant_exceeds_ceiling | grant_widening_refused`,
`429 channel_cap_per_day | channel_cap_per_hour | channel_min_interval |
channel_phase_duplicate` (with `retryAfterSeconds`) `| approval_queue_full`,
`503 channel_credential_unavailable | channel_event_check_unavailable |
approval_owner_unbound | approval_owner_key_mismatch |
approval_proof_unavailable`; resolve also answers `400
approval_decision_mismatch` and `403 approval_proof_invalid` (with `reason`);
also `409
channels_not_configured | channel_paused | consent_inactive |
grant_inactive` and `422 channel_attachment_type_mismatch |
channel_kind_unsupported`.

Order and consumption (§6 3a–3e): nothing is held, reserved or consumed before
every earlier check passed. At send time (immediate, approved, scheduled) the
digest is recomputed from the stored post, the current channel destination and
the attachment bytes read from disk; a mismatch is `channel_digest_mismatch`
and the post is `skipped`.

### `marketplace.approvals.resolve`

Contract K1 (alpha.6). The manifest names it as `approvals.resolveOperation`.
Body: the contract `approvalResolveRequestSchema`, `{approvalId, proof}` with
`proof` either `{proof: "nostr", event: <full owner-signed NIP-01 event>,
channel: <conversation UUID>}` or `{proof: "portal", token: <compact JWS>}`;
`approvalId` must equal the path (otherwise, or for any other key, `400
validation_failed`). Key `resolve.<approvalId>.<approve|deny>`. Only the
caller's own held call (otherwise `404 approval_not_found`).

Single-shot: a guarded update moves the hold `pending → resolving` (one SQL
statement, no await inside); a refused proof moves it back; a valid proof is
recorded as used (instance-wide, `markUsedApprovalProof`, after every other
check so a refused proof never burns its id), then the decision runs once.
Any other resolve while resolving or after the decision is `409
approval_already_resolved` and never calls a provider; the same key after
success replays the stored answer. A deny skips the post with no provider call.
The owner Approvals view uses the same states.

* `nostr`: the reply must be `approve <32-character code>` (the first 32+ hex
  of the digest). Contract alpha.7 `verifyNostrApprovalProof` enforces the
  32-hex minimum itself (`NOSTR_MIN_DIGEST_PREFIX`); a shorter code is `409
  approval_proof_prefix_too_short` and burns nothing. `verifyNostrApprovalProof` runs with the forwarded event and
  `channel` (the event's `h` tag must equal it), the held digest, age ≤ 15
  minutes, kind 9, recomputed NIP-01 id, BIP-340
  signature, and the owner key **pinned on the hold at creation**. That key
  must still be the current owner key (same fingerprint and epoch); otherwise
  `409 approval_owner_key_changed` (also for a hold created before any key
  was set). A reply binds only its prefix, not the approval id, so it is `409
  approval_proof_ambiguous` when the prefix also matches another approval of
  the workspace (any state, different digest) created in the last 20 minutes
  (15 min max age + 5 min skew), or any other live held call of the instance. An event signed before the current key was set is `403
  approval_proof_invalid` (`reason: key_changed`). No key: `503
  approval_owner_unbound`. When Portal attests the owner's key (v2) and it
  differs from the owner setting, or when the attestation cannot be read or
  is malformed (fail closed): `503 approval_owner_key_mismatch`.
* `portal`: `verifyOwnerApprovalAssertion` with the issuer-pinned grant JWKS
  of the claim binding (`ownerApprovalOptionsFromClaim`: pinned issuer,
  `jwksUri`, grant kids), `aud = tealbrick-app:<claimed instanceId>`, `dep` =
  own deployment id, `sub` = the pinned `ownerSubject`, `approvalId`,
  `digest`, `op` (the held operation: `marketplace.channels.post` /
  `.schedule`, or `marketplace.tools.call`), `agent =
  tealbrick-agent:<agentId>`, `decision`, `exp − iat ≤ 300 s`, single-use
  `jti` (kept until `exp` + the contract clock skew, 60 s). Type separation: an L2 grant JWT is `403
  approval_proof_invalid` (`reason: wrong_header_type`). The assertion's
  `amr` and `device` claims are stored on the approval record (metadata;
  shown in the owner view as `proof`). An unreachable JWKS is `503
  approval_proof_unavailable`.

Refusal reasons (`reason`): `wrong_channel`, `wrong_owner`, `bad_signature`,
`stale`, `not_yet_valid`, `wrong_digest`, `prefix_too_short`, `ambiguous`,
`ambiguous_prefix`, `wrong_kind`, `bad_id`, `key_changed`, `malformed`
(nostr); the
contract `OwnerApprovalDenialReason` values (portal). A replayed proof of
either type is `409 approval_proof_reused`.

Owner pin. The owner comes only from the contract claim binding (alpha.7:
`ownerSubject`, `ownerPinnedAt`; re-pinned only by a newer claim, cleared by
a claim without it), read through `channels/owner-pin.ts`. The Portal launch
credential's `ownerSubject` is never used to authorize a caller or to re-pin.
The source is the manifest-claim handler's `claim.store` (read with `await
claim.store.read()`). The pinned `ownerSubject` goes to
`verifyOwnerApprovalAssertion` as is. With no pin (no claim yet, or a cleared
pin), `portal` proofs answer `503 approval_owner_unbound` and owner key writes
answer `409 approval_owner_unbound`.

App authority. `channels.post` and `channels.schedule` declare
`approvalAuthority: "app"` with `appHold: true`. Marketplace holds every call
it has no owner authority for whatever Portal's `approvalTrusted` says; the
flag only lets the harness skip its own prompt (`harnessDefersToApp`: external
effects, app authority, hold, resolve operation, and `approvalTrusted: true`
in the signed config and the live grant). `channels.test` stays harness
authority: the contract refuses `"app"` on owner-audience operations (no
harness calls them; the owner's click is the authority).

### Owner Buzz key (v1)

`approvals.ownerNostrPubkey` is app-owned, owner-only Marketplace state. It
is not a manifest setting (Portal's settings relay cannot write it) and not a
provider-env or account field.

| Operation | Route |
| --- | --- |
| `marketplace.approval-owner-key.get` | `GET /api/marketplace/approvals/owner-key` → `{ownerKey: {setting, fingerprint, ownerKeySource: owner-session|portal-attested|null, ownerKeyStatus: unset|ok|mismatch|error, attestedFingerprint, setAt, ownerPin: pinned|unbound}}` |
| `marketplace.approval-owner-key.update` | `PUT /api/marketplace/approvals/owner-key` `{pubkey}` → `{changed, invalidatedHolds, ownerKey}` |
| `marketplace.approval-owner-key.clear` | `DELETE /api/marketplace/approvals/owner-key` → `{changed, invalidatedHolds, ownerKey}` |

* Writes need the owner's own operator session from a Portal launch ticket,
  with its CSRF token (checked by the route itself). Refused (`403
  owner_session_required`, or earlier `401`/`403`): agents (`tbag_`, as
  owner operations), runtime leases, the service bearer, the settings relay
  bearer, the emergency session, the operator access-token session and the
  test bypass. The claim binding must pin the owner (`ownerSubject`) and the
  launch user must be that owner; without a pin every write is `409
  approval_owner_unbound` (`ownerPin: "unbound"`; the Settings control says
  "Available after Portal confirms the deployment owner").
* Format: the owner pastes the npub (public key; the UI never asks for a
  private key). Accepted: a NIP-19 `npub1…` (bech32, checksum verified) or 64
  hex characters (either case; stored lowercase). `nsec`, other prefixes, whitespace and
  free text are `400 owner_key_invalid`.
* Only the fingerprint (first 16 hex of sha256 over the 32 key bytes) is
  shown, returned or audited. The Approvals list (`marketplace.approvals.list`)
  carries the same `ownerKey` view; each approval carries `ownerKey:
  {fingerprint, status: pinned|unpinned|key_changed}`.
* Every change (set, change, clear) bumps the key epoch, marks every pending
  hold pinned to the previous key `key_changed` (it stays held; approve it in
  the owner UI or let the agent ask again) and writes the audit event
  `marketplace.approvals.owner_key.changed` `{change, oldFingerprint,
  newFingerprint, invalidatedHolds, at}` with the actor.
* Trust source: `owner-session` today. When Portal attests the key (v2 claim
  field `ownerNostrPubkey`, also read through `channels/owner-pin.ts`, null
  today), an equal key is `portal-attested` and a different one is
  `ownerKeyStatus: "mismatch"`. An unreadable store or a malformed value is
  `ownerKeyStatus: "error"`, never "not attested". Both refuse Buzz proofs
  (fail closed).
* The Approvals view shows each held channel post's 32-character Buzz code
  (the first 32 hex of its digest): the owner replies `approve <code>`.

### Owner operations (`audience: owner`)

| Operation | Route |
| --- | --- |
| `marketplace.channels.browse` | `GET /api/marketplace/channels` (`configured`, `providers` with each configured provider's effective capabilities (`channelCapabilities: 2`: v1 keys plus `dm`, `thread`, `mentions`, `reactions`, `edit`, `delete` (with an optional `windowSeconds`), `canvas`, `presence`, `ephemeral`, `live`, `inbound`, `poll` (`false` or the provider's limits) and the optional `markupOptions` (markups a post may ask for besides `markup`); the declaration narrowed to the wired features, so a feature no agent operation uses reads `false` or `none` and `markupOptions` lists only wired markups; each connection carries its `peoplePolicy`) and kinds, channels, readiness, connections, pending grants, uncertain posts) |
| `marketplace.channels.discover` | `GET /api/marketplace/channels/discover?provider=` |
| `marketplace.channels.create` | `POST /api/marketplace/channels` (Idempotency-Key; destination from discovery only; optional `kind`, only kinds the provider serves, else `422 channel_kind_unsupported`) |
| `marketplace.channels.update` | `PATCH /api/marketplace/channels/{channelId}` (bumps `revision`, re-checks grants) |
| `marketplace.channels.pause` / `.resume` / `.archive` | `POST /api/marketplace/channels/{channelId}/pause|resume|archive` |
| `marketplace.channels.test` | `POST /api/marketplace/channels/{channelId}/test` (fixed text, authority `owner-test`) |
| `marketplace.channel-grants.approve` / `.decline` / `.revoke` | `POST /api/marketplace/channels/grants/{grantId}/approve|decline|revoke` (approve takes an optional narrower `final`) |
| `marketplace.channel-posts.list` | `GET /api/marketplace/channels/posts?status=held,scheduled,uncertain&channelId=` (send time, channel, agent, digest prefix, approval state; no text) |
| `marketplace.channel-posts.cancel` | `POST /api/marketplace/channels/posts/{postId}/cancel` (scheduled posts, and held posts, immediate or scheduled; in one transaction with the post: denies a waiting approval, fails an approved one; refused once sending started) |
| `marketplace.channel-posts.resolve` | `POST /api/marketplace/channels/posts/{postId}/resolve` `{status: sent|failed}` |
| `marketplace.channel-receipts.export` / `.purge` | `GET /api/marketplace/channels/receipts/export`, `POST /api/marketplace/channels/receipts/purge` `{olderThanDays}` (default 90; finished posts only; answers `{purged, skipped}`) |
| `marketplace.channel-inbound-routes.update` | `PUT /api/marketplace/channels/{channelId}/inbound` `{enabled, agentId?, agentBuzzPubkey?}` → `{route, receivers}` (see [Inbound](#inbound-channels-p2); `agentBuzzPubkey` for the [Buzz bridge](#buzz-channels-p2)) |
| `marketplace.channel-inbound-events.list` | `GET /api/marketplace/channels/inbound/events?channelId=&limit=&before=` (metadata, route outcome, at most 500 characters of text per event, receiver status) |
| `marketplace.channel-inbound-settings.update` | `PUT /api/marketplace/channels/inbound/settings` `{textRetentionDays?: 1-365, discordMessageContent?: bool}` |
| `marketplace.channel-people-policy.get` / `.update` | `GET|PUT /api/marketplace/channels/connections/{connectionId}/people-policy` `{mode: none|allowlist|workspace, people?, domains?}` (see [Routes v2](#routes-v2-channels-p2)) |
| `marketplace.channel-people.list` / `.revoke` | `GET /api/marketplace/channels/connections/{connectionId}/people?approved=`, `POST .../people/{personRef}/revoke` |
| `marketplace.channel-buzz-identity.get` / `.update`, `marketplace.channel-buzz-key.generate`, `marketplace.channel-buzz-auth-tag.revoke` | `GET|PUT /api/marketplace/channels/buzz/identity`, `POST .../identity/key`, `DELETE .../identity/auth-tag` (see [Buzz](#buzz-channels-p2)) |
| `marketplace.channel-live-grants.inbox` | `GET /api/marketplace/channels/live` (live-session grants with canonical JSON, digest, consent values, caps and usage; recent sessions; the owner switch) |
| `marketplace.channel-live-grants.approve` / `.restrict` | `POST /api/marketplace/channels/live/grants/{grantId}/approve` `{digest}`, `POST .../narrow` `{terms}` (pinned owner's launch session) |
| `marketplace.channel-live-grants.decline` / `.revoke` / `.pause` / `.resume` | `POST /api/marketplace/channels/live/grants/{grantId}/decline|revoke|pause|resume` (resume: pinned owner) |
| `marketplace.channel-live-control.update` | `PUT /api/marketplace/channels/live/control` `{paused?, commandChannel?}` (resume and command channel: pinned owner) |
| `marketplace.channel-live-sessions.stop` / `.transcript` | `POST /api/marketplace/channels/live/sessions/{sessionId}/stop`, `GET .../transcript` |

"Grant to agent" is `marketplace.consents.request` with the channel's class
selection (each channel in `browse` carries it as `grantSelection`, with the
display-only `actionGroupLabel`, plain text of at most 80 characters, which
Portal never stores and Marketplace never persists). Per-payload approvals are
the existing `marketplace.approvals.*` queue; channel holds show the channel,
the digest and, on `get`, the exact payload view.

### Credentials and readiness

Bot tokens come from `MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN`,
`MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN` and
`MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN` (settings group `channels`,
account-sourced provider env, read at start), or self-hosted from the encrypted
`connector_secret` `botToken` under `channels-<provider>`. Each is verified once
at start; the connection row keeps only `{botId, botUsername, verifiedAt,
credentialRef}` (Slack adds `teamId`). Buzz has no token: its credential is the Marketplace-generated
agent key (connector secret `agentSecretKey` under `channels-buzz`) with the
owner's relay URL and NIP-OA tag (see [Buzz](#buzz-channels-p2)). Readiness per provider (`available | credential_missing |
credential_invalid | unavailable`) is in `browse` and in
`/api/portal/readiness` (`channels.providers`). Tokens are never in responses,
receipts, rows, logs, audit or errors; provider text is redacted before it is
written.

### Slack (Channels P2)

Adapter: `program/src/channels/providers/slack.ts` (Slack Web API, bot token
`xoxb-` as a Bearer header, form-encoded POST bodies; readiness = `auth.test`).
Each customer creates an **internal** Slack app in its own workspace from
`docs/channels-slack-app-manifest.json` (api.slack.com/apps → Create New App →
From a manifest), installs it and adds the Bot User OAuth Token under Account
Connections. Internal apps keep Slack's normal history-read limits; new
non-Marketplace distributed apps are limited since 29 May 2025, so the app is
never distributed. Least privilege: the manifest requests only the bot scopes
of features that ship today: `chat:write` (post, the owner test, edit and
delete of the agent's own message), `files:write` (upload v2), `channels:read`
and `groups:read` (discovery), and since routes v2 `users:read.email` (find a
person by email), `im:write` (open a direct message with one person) and
`reactions:write` (reactions). Existing installs must update the app from the
manifest and reinstall it to get the three new scopes; until then those
operations fail with `slack: missing_scope` and nothing is sent. There is no
`chat:write.public`: the bot posts only where it is a member, and discovery
(`conversations.list`, public and private, members only, archived excluded, at
most 1000) lists only those channels. `verify` records the installed workspace
(`auth.test` `team_id`, required) on the connection row as `teamId`; the inbound
helpers ignore a signature-verified event whose envelope `team_id` is another
team or missing. The optional signing secret
(`MARKETPLACE_CHANNELS_SLACK_SIGNING_SECRET`, or connector secret
`signingSecret` under `channels-slack`) is for inbound verification only, never
affects readiness, and is redacted like the bot token.

Scopes that later features add (each lands in the change that ships the
feature, never earlier): native schedule needs no new scope (`chat:write`);
find a person by handle adds `users:read` (not requested: Slack people are
found by email only, a handle answers `422 channel_person_query_unsupported`;
named mentions need no scope);
receiving messages (inbound) adds `channels:history` and `groups:history` and
the event subscriptions `message.channels` and `message.groups` in the inbound
manifest variant `docs/channels-slack-app-manifest.inbound.json` (request URL
`https://<your Marketplace host>/api/marketplace/channels/slack/events`; DMs
are not routed yet, so no `im:history` / `message.im`). Use the inbound variant
only when the owner turns inbound on for a Slack channel.

Inbound (see [Inbound](#inbound-channels-p2)): the Events API route uses
`acceptSlackEvent`, which checks, in order, the
`X-Slack-Signature` over the raw body (`rejected`: answer 401), the team, then
the `event_id` in a bounded replay store (`createSlackEventDedupe`: 15 minutes,
10,000 ids, which covers Slack's retries and the ±300 s signature window); a
repeat is `ignored` with reason `duplicate`.

Sending: `chat.postMessage` with `mrkdwn`, `parse: none`, `link_names: false`.
User text is escaped (`&`, `<`, `>`), so it cannot form `<!channel>`, `<!here>`,
`<!everyone>`, user, group or channel mentions, or links; a named mention is a
`<@USERID>` that the caller lists in `mentions`. Text over 40,000 characters
(after escaping) is refused. Replies use `thread_ts`. Files use upload v2
(`files.getUploadURLExternal`, bytes to the returned Slack URL without the
token, one `files.completeUploadExternal` with the text as `initial_comment`);
a failure before the share step is `failed` (nothing is visible), a failure at
or after it is `uncertain`. Slack returns file ids, not a message ts, for a
file post, so those receipts carry `F…` ids. Voice is a declared fallback
(audio file + transcript). Used by the routes v2 operations: `react`
(`reactions.add/remove`), `edit` (`chat.update`), `remove` (`chat.delete`),
`findPerson` (`users.lookupByEmail`; the handle path through a `users.list`
cache stays unused), `openDirect` (`conversations.open`) and named mentions in
`send` (replies in `send` are used only by `marketplace.channels.reply`).
Adapter-level only (wired filter): the opt-in `scheduleNative`
(`chat.scheduleMessage`, 1 minute to 120 days ahead, 30 per 5 minutes per
channel). Marketplace's own scheduler stays the default,
because it re-checks authority and caps at send time. Limits: one message per
second per channel; HTTP 429 `Retry-After` is honoured once (≤ 30 s).

### Telegram and Discord additions (Channels P2)

The routes v2 operations use these adapter methods (reply through
`marketplace.channels.reply`; react, edit, delete, polls, markup and DMs
through [Routes v2](#routes-v2-channels-p2)); the declarations say exactly
what they do.

Telegram (`telegram.ts`, Bot API 10.3): replies use `reply_parameters`
`{message_id, allow_sending_without_reply: false}` on the first message of a
post. `markup` stays `plain`; a post may ask for `markdown-v2`
(`markupOptions`): the agent text is escaped for every MarkdownV2 special
character, and only a safe subset stays live (`*bold*`, `_italic_`, `` `code` ``,
`[label](https://…)`, one line, not nested, bold and italic not inside a word);
user mentions, spoilers, quotes and custom emoji can never be formed. Reactions:
`setMessageReaction` with one emoji from Telegram's fixed list (bots set at most
one; remove sends an empty list). `edit` = `editMessageText`, or
`editMessageCaption` (≤ 1024) when Telegram answers that the message has no
text; "message is not modified" counts as sent. `remove` = `deleteMessage`
(`delete.windowSeconds` 172800: Telegram deletes only messages younger than 48
h). Polls: `sendPoll` (question ≤ 300, 2–12 options ≤ 100, anonymous,
`allows_multiple_answers` on request; a non-empty text goes first as its own
message, so a failure between them is `uncertain` + `partial`). No DMs:
Telegram bots cannot start a conversation, so `dm.open` is false and
`findPerson`/`openDirect` are absent. Pure inbound helpers:
`verifyTelegramSecretToken` (`X-Telegram-Bot-Api-Secret-Token`, constant
time) and `parseTelegramUpdate` (`message`, `edited_message`, `channel_post`,
`edited_channel_post`).

Discord (`discord.ts`, REST v10): voice is a native voice message (flag
`IS_VOICE_MESSAGE` 8192, one `audio/ogg` attachment with `duration_secs` and a
base64 `waveform` of at most 256 bytes, no content). The duration is the last
Ogg granule position minus the Opus pre-skip; the waveform is approximated from
the Opus packet sizes (no decoder; Discord calls the waveform an implementation
detail). `buildDiscordVoicePayload()` is pure and feeds the digest. The post
text and the transcript follow as a second message replying to the voice
message; a failure of that message is `uncertain` + `partial`. Replies:
`message_reference {message_id, fail_if_not_exists: true}` with
`allowed_mentions.replied_user: false`. Mentions: a `<@id>` pings only when the
id is listed (`allowed_mentions.users`, `parse` always empty, ≤ 20). Active
threads under listed channels are discovered as `thread` destinations. Reactions:
`PUT`/`DELETE …/reactions/{url-encoded emoji}/@me` (Unicode or custom
`name:id`). `edit` = `PATCH` own message, `remove` = `DELETE`. Polls: the
Discord poll object (question ≤ 300, 1–10 answers ≤ 55, `duration` 1–768 h,
default 24). DMs: `findPerson` by handle only (Search Guild Members, ≤ 5 per
guild, ≤ 10 guilds, exact match on username, global name or nickname, else
`not_found` or `ambiguous`; no email lookup exists for bots) and `openDirect`
(`POST /users/@me/channels`). Scheduled events stay `events.create: false`.
Pure inbound helper: `parseDiscordMessageCreate` (gateway `MESSAGE_CREATE`;
content is empty without the privileged Message Content intent except DMs and
mentions). Bot permissions for these features: Send Voice Messages, Send Polls,
Add Reactions, Read Message History, Send Messages in Threads.

### Microsoft Teams (Channels P2)

Adapter: `program/src/channels/providers/teams.ts` (Bot Framework REST, the
transport under the Teams SDK; not Graph `chatMessage` send, which is
migration-only for applications). One single-tenant Azure Bot per customer
(new multi-tenant bot registrations ended 2025-07-31). Credentials:
`MARKETPLACE_CHANNELS_TEAMS_APP_ID`, `MARKETPLACE_CHANNELS_TEAMS_APP_SECRET`,
`MARKETPLACE_CHANNELS_TEAMS_TENANT_ID` (all three, or self-hosted connector
secrets `appId`, `appSecret`, `tenantId` under `channels-teams`; a partial set
is `credential_missing`), composed into one opaque credential at start; the
secret is redacted on its own. Readiness = a client-credentials token from
`login.microsoftonline.com/<tenant>/oauth2/v2.0/token`
(`https://api.botframework.com/.default`), cached until five minutes before
expiry and never logged. Owner setup: `docs/channels-teams-setup.md`, app
package template `docs/channels-teams-app-manifest.json` (bot scopes only, no
resource-specific consent: Teams then delivers only mentions and 1:1 messages).
`docs/channels-teams-app-manifest.inbound.json` adds the RSC permissions
`ChannelMessage.Read.Group` and `ChatMessage.Read.Chat` (every message of each
installed team and chat); it is for when the owner turns on Teams inbound, which
does not exist yet, so customer messages are never pushed with no use.

Messaging endpoint: `POST /api/marketplace/channels/teams/messages` (the Azure
Bot's messaging endpoint). It is a public path at the Marketplace level (like
the Composio OAuth callback), not a manifest operation: agents never call it,
the grant guard only sees `tbag_` bearers, and the contract test maps
operations to routes, not routes to operations. Every request needs a Bot
Framework JWT (a missing or non-JWT bearer is refused before the body is
parsed; body limit 128 KB; a per-source budget of 60 requests burst, 2/s,
answers 429): RS256 with a key from
`login.botframework.com/v1/.well-known/openidconfiguration` (keys cached 24 h;
at most one fetch per 5 min whatever the outcome, stale keys stay usable while
a refresh fails; `jwks_uri` pinned to `login.botframework.com`), `iss`
`https://api.botframework.com`, `aud` = app id, `exp`/`nbf` with 5 min skew,
the `serviceurl` claim (lowercase, `serviceUrl` accepted as a fallback) =
activity `serviceUrl`,
key endorsed for `msteams`. The `serviceUrl` must be https on
`smba.trafficmanager.net` or `smba.infra.gcc.teams.microsoft.com` (GCC High,
DoD and 21Vianet are not supported). `installationUpdate` /
`conversationUpdate` (bot added or removed, team or channel deleted) store or
remove the conversation reference in `channel_teams_conversation` (additive
table: workspace, conversation id and type, team and channel id, cleaned team
name and title, membership, serviceUrl, tenant, installed/removed/updated at).
Activities for another tenant or bot are ignored, and so are messages from
any other bot (`from.role` `bot`, or a `28:` sender). Replays: an activity
needs an `id`; each conversation + activity id is processed once while its
token is valid (kept until `exp` + 5 min, at least 1 min, at most 24 h; at most
20,000 ids in memory), because a Bot Framework token is not bound to the body.
An activity without an id, or a repeat, is answered 200 and changes nothing.
Message activities are parsed into the normalized inbound shape and, after
the replay check and the bot filter, handed to the inbound pipeline
(`inbound: {mode: "webhook", dedupe: true}`; see [Inbound](#inbound-channels-p2)).

1:1 references are capped at 5,000 per tenant (removed rows go first, then
the oldest). Discovery reads each kind (team channels, group chats, 1:1 chats)
with its own limit of 1,000, so no kind crowds out another, and a chat title
always starts with its kind (`Group chat: …`, `Direct chat: …`) so a chat name
cannot pass for a team channel (`Team / #channel`); the picker also shows the
destination type.

Discovery: standard channels of each installed team (live
`GET {serviceUrl}/v3/teams/{teamId}/conversations`, falling back to the stored
channels), group chats and 1:1 chats. Private and shared channels are left
out and named in `notes`: bots cannot post there. Sending:
`POST {serviceUrl}/v3/conversations/{id}/activities` (`type: message`,
`textFormat: markdown`), thread replies on `.../activities/{replyToId}`
(channels only). Text over 28,000 characters (or an activity over 100,000
bytes) is refused. Mentions: `<at>name</at>` plus a mention entity, only for a
Teams user id (`29:…`) or an Entra object id that the caller lists (with its
`name`); an undeclared `<at>` tag is refused, so a team, channel or tag is
never mentioned. No files, images, cards or reactions in this version.
`edit` = `PUT .../activities/{id}`, `remove` = `DELETE`. Mentions, `edit`,
`remove`, `findPerson` and `openDirect` are used by the routes v2 operations
(Marketplace checks the message id against its own sent-message ledger before
an edit or delete; a mention needs its `name` and an `<at>name</at>` in the
text, checked before any hold). Thread replies are used by `marketplace.channels.reply`
(reply to the source thread of an inbound event). `findPerson` (Graph
`users?$filter=mail eq … or userPrincipalName eq …`, User.Read.All
application permission) and `openDirect` (`POST {serviceUrl}/v3/conversations`,
1:1, the app must already be installed for that person) exist only when
`MARKETPLACE_CHANNELS_TEAMS_GRAPH_ENABLED` is `true`, which also declares
`dm.open`; otherwise `channel_capability_unavailable`. Proactive install for a
person (Graph `TeamsAppInstallation`) is a later step. Limits: per
conversation 7/1 s, 8/2 s, 60/30 s, 1800/h and 50 requests/s per tenant
(local token buckets). 429 honours `Retry-After` once (≤ 30 s); 412 is retried
once with jittered backoff; 502/504 are retried once only for idempotent calls
(PUT, DELETE, create-conversation) and a send is never retried (`uncertain`).

### Buzz (Channels P2)

Adapter: `program/src/channels/providers/buzz.ts` over the relay's Nostr HTTP
bridge (block/buzz `crates/buzz-relay/src/router.rs`): `POST /events` (submit
a signed event; answer `{event_id, accepted, message}`), `POST /query` (NIP-01
filters), `PUT /media/upload` (Blossom BUD-02) and `GET /` (NIP-11). Every
call carries NIP-98 (`Authorization: Nostr <base64 kind 27235>` with `u` =
the exact URL, `method`, a fresh `nonce` and `payload` = SHA-256 of the body)
and the owner's NIP-OA tag in `x-auth-tag` (relay membership through the
owner, NIP-AA). Every published event is signed by the connection's agent key
and carries the NIP-OA `auth` tag. BIP-340 keys and signatures use
`@noble/curves` 2.4.0 (the version `@tealbrick/contract` ships); event ids and
signature checks use the contract helpers `nostrEventId` /
`nostrSignatureValid`. There is no default relay: the owner-entered relay URL
inside the identity is the only target, and no redirect is followed.

Identity and custody (Coordinator, 2026-10-10). Marketplace generates one
secp256k1 key per Buzz connection and writes the secret only to the encrypted
`connector_secret` store (`channels-buzz` / `agentSecretKey`). It is never
shown, exported in plain text, imported, logged, audited or returned. The
database backup does contain its encrypted ciphertext ("never backed up" in the
custody rule means never exported in plain text): restoring a backup without
Marketplace's encryption key is useless, and the key is never in a backup. Loss
of the store means a new key and a new tag. Public state lives
in the additive table `channel_buzz_identity` (agent public key, relay URL,
tag JSON, its SHA-256, owner key, conditions, end date). Owner operations
(audience owner; they work in inert mode, where a first identity takes effect
after the next start and the answer says `appliesAfterRestart: true`). Reads
need any operator session; every WRITE (key generate/rotate, relay URL, tag,
revoke, and a route's `agentBuzzPubkey`) needs the strict owner gate of the
owner-key routes: the owner's own Portal launch session with its CSRF token
and the pinned `ownerSubject` equal to the session user (`403
owner_session_required`; without a pin `409 approval_owner_unbound`), so no
other operator can point the bridge at another relay or agent key.

| Operation | Route | Effect |
| --- | --- | --- |
| `marketplace.channel-buzz-identity.get` | `GET /api/marketplace/channels/buzz/identity` | npub, relay URL, tag status (`missing`, `valid`, `invalid`, `expired`) with reason, end date, days left, `renewalDue` (< 14 days), tag SHA-256, pinned owner fingerprint, and `signing.preimage`: the exact NIP-OA text to sign for a 90-day tag. Also in the owner browse (`buzz`). |
| `marketplace.channel-buzz-key.generate` | `POST /api/marketplace/channels/buzz/identity/key` `{rotate?}` | Generate the key (`409 buzz_key_exists` when one exists), or rotate it. Before a rotation, with the OLD key still in the store, the bridge deletes every bridged message still on the relay (kind 5, one per event) and its bridge channels (kind 9008), since Buzz deletes are author-only; the answer carries `bridgeCleanup: {deleted, failed, channelsDeleted}` and rotation proceeds even if the relay is down. Then the old secret is overwritten, the tag cleared and every route unconfirmed (its channel retired). |
| `marketplace.channel-buzz-identity.update` | `PUT /api/marketplace/channels/buzz/identity` `{relayUrl?, authTag?}` | Relay: `wss://host[:port]` only, a DNS name or an IP literal (`422 buzz_relay_url_invalid`), and egress rules (below; `422 buzz_relay_host_blocked`, `buzz_relay_address_blocked`, `buzz_relay_dns_failed`). A change clears the tag (readiness `credential_missing` until the owner pastes a tag again) and unconfirms every bridge route (bridge paused, `buzz_relay_changed`, until the owner saves the route again); audit `relay_changed` `{oldRelayHost, newRelayHost, actor, pausedRoutes}`. Tag: `["auth", ownerHex, conditions, sig]`, verified: BIP-340 by `ownerHex` over SHA-256 of `nostr:agent-auth:<agent hex>:<conditions>` (conditions verbatim), owner ≠ agent, the NIP-OA conditions grammar, `ownerHex` = the pinned owner Buzz key (`approvals.ownerNostrPubkey`; none set → `409 buzz_owner_key_required`), a `created_at<T` end with now < T ≤ now + 90 days, no `kind=` clause (NIP-OA kind clauses are conjunctive, so a limited tag cannot cover the kinds Marketplace signs, `BUZZ_SIGNABLE_KINDS`; `422 buzz_auth_tag_kinds_too_narrow`; the view lists `authTag.allowsKinds`). Refusals `422 buzz_auth_tag_<reason>`; a pasted `nsec` is refused and never echoed. |
| `marketplace.channel-buzz-auth-tag.revoke` | `DELETE /api/marketplace/channels/buzz/identity/auth-tag` | Clear the tag: Marketplace stops publishing and receiving at once. The tag stays valid on the relay until its end date; rotation ends it for good. |

Relay egress (Coordinator rules; `program/src/channels/buzz-relay-guard.ts`):
no fixed allowlist, `wss://` only, and in production every address the relay
host resolves to (A and AAAA, every one) must be public: loopback, unspecified,
RFC 1918, IPv6 ULA fc00::/7, link-local 169.254/16 and fe80::/10 (cloud
metadata 169.254.169.254, fd00:ec2::254), CGNAT 100.64/10, multicast and
reserved ranges, their IPv4-mapped and NAT64 forms, and local or metadata names
(`localhost`, `*.local`, `*.internal`, `metadata.google.internal`, single-label)
are refused; IP-literal hosts get the same checks. The check runs when the owner
sets the relay and again at every connection: the adapter's HTTP client and the
relay socket use an undici agent whose connect lookup resolves again, checks
every answer and connects only to a checked address, so a DNS change cannot
bypass it. `MARKETPLACE_CHANNELS_BUZZ_ALLOW_PRIVATE_RELAY=1` allows private
relays for development only: env only (not a manifest setting, so Portal cannot
set it), off by default, and honoured only when `NODE_ENV` is exactly
`development` or `test` (unset or anything else: off). IPv6 addresses that carry
an IPv4 address in any notation (IPv4-mapped, IPv4-compatible, NAT64
64:ff9b::/96 and 64:ff9b:1::/48, 6to4 2002::/16, Teredo 2001::/32) get every
IPv4 rule applied to the embedded address.

Signable kinds: `BUZZ_SIGNABLE_KINDS` (`providers/nostr.ts`) is the only set of
kinds Marketplace signs with the agent key: 9, 7, 5, 40003, 41010, 9007, 9000,
9001, 9008, 20002, 22242 (NIP-42 AUTH), 27235 (NIP-98), 24242 (Blossom). The one
signing function and `publish()` (the single choke point for every published
event) refuse anything else (`buzz_kind_not_allowed`); the owner
screen shows the list next to the tag (`signableKinds`); a test snapshots the
list and scans the source for event construction sites. Changing it needs a
spec change (docs/channels-p2-scope.md §3).

Readiness: `credential_missing` (no key, relay or tag), `credential_invalid`
(a tag that ended, no longer names the pinned owner key, has no pinned owner
key to name, or no longer verifies; re-checked on every readiness read), `available` after `verify`
(NIP-11, then an authenticated `/query` for the agent's own profile).
`connections.buzz.botUsername` is the short npub. Audit
(`marketplace.channels.buzz.key_generated | key_rotated | relay_changed |
auth_tag_set | auth_tag_revoked`) records npubs, the relay URL, the tag SHA-256,
the owner fingerprint and the end date, never the key. A tag with a `kind=`
clause authorises only that kind: other operations answer
`buzz_auth_kind_not_allowed`.

Capabilities (`channelCapabilities: 2`, truthful for this PR): text (20,000
characters, 64 KiB as sent), `markup: "buzz-markdown"`, mentions of named
members (p tags) with broadcast suppressed, `dm: {open: true, maxMembers: 1}`,
images JPEG/PNG/GIF/WebP (50 MiB; GIF 10 MiB) and MP4 (50 MiB, the
Marketplace upload cap) through Blossom, `file`, `audio` and `voice` `false`
(PDF and text uploads are not verified on the deployed relay; the relay
refuses audio, so there is no voice fallback), replies, reactions add/remove
(no custom emoji), edit and delete own, `presence.typing`, `canvas: false`
(read and propose-edit come later), no polls, no native schedule, `discover:
"list"`, `inbound: {mode: "socket", dedupe: true}`, `perChatPerMinute: 100`.

- Discover: `/query` kind 39002 with `#p` = the agent key (its channel
  memberships), then kind 39000 for those ids: open channels `channel`,
  private ones `group`, DMs (`hidden`) `person`; archived channels and the
  bridge's own `tb-inbound-*` channels are left out (named in `notes`).
- Send: kind 9 with `h` = channel UUID, `p` tags only for listed mentions
  (npub or hex), `nostr:npub…` references of others lose the `nostr:` scheme,
  `@everyone`, `@here`, `@channel`, `@all`, `@room` get a full-width at sign,
  never a `broadcast` tag. Replies: the parent must be an event of the same
  channel (else `channel_reply_invalid`, nothing posted); NIP-10 `e` tags with
  `reply` (and `root` for a nested reply). Files: Blossom upload (kind 24242
  auth: `t=upload`, `x` = SHA-256, `expiration`, `server`; base64url), then an
  `imeta` tag (`url`, `m`, `x`, `size`, `dim`) and a Markdown image line.
- Reactions: kind 7 (`e`, `h`); remove = one single-target kind 5 per matching
  reaction of the agent (Buzz rejects multi-target deletions). Edit: kind 40003, delete: kind 5, both only for the agent's own
  messages (checked first: `provider_forbidden`). Typing: kind 20002 (at most
  one per 5 s per channel, never queued).
- People: `findPerson` by npub or exact member name (display name or name)
  among members of the agent's channels, never a list (`ambiguous` for two);
  no email lookup. `openDirect`: Buzz DM open (kind 41010) with one member;
  the relay answers the DM channel id (`message: "response:{channel_id}"`).
- Failures: relay `accepted: false` is `failed / provider_rejected` with the
  relay's reason (scrubbed); HTTP 401 `credential_invalid`, 403
  `provider_forbidden`, 400/409 `provider_rejected`, 503 `failed`, 500/502/504,
  timeouts and network errors `uncertain`, 429 retried once. A local bucket
  (10 burst, 100 a minute) stays under the relay's default agent limit (120 a
  minute).

Inbound: one relay socket per agent key (`program/src/channels/buzz-relay-socket.ts`),
only while a Buzz channel has an enabled route and the identity is available,
under the consumer lease `buzz:<first 32 hex of sha256(credential)>`. Bridge
channels (current or retired) are delivery-only: never subscribed, never routed
(`ignored / buzz_bridge_channel`) and never a Marketplace channel
(`409 channel_destination_is_bridge`). Events authored by any enabled route's
agent Buzz key are dropped in the socket and in the pipeline
(`ignored / buzz_routed_agent`), so an agent's own post never comes back to it.
The socket's own-key filter uses the stored public key, the tag is checked
against the pinned owner key, the socket stops at the tag's end date, and it is
stopped and reconciled after an owner-key change or when the identity stops
being available. On the
relay's `["AUTH", challenge]` (at connect and mid-session) it answers kind
22242 with `relay`, `challenge` and the NIP-OA tag; after `OK true` it sends
`REQ tb-channels {kinds: [9], "#h": [routed channel ids ≤ 128], since}` and
`REQ tb-membership {kinds: [44100, 44101], "#p": [agent key], since}`. Events
are verified (id + BIP-340) and parsed (`threadId` = NIP-10 root, imeta
attachments as metadata) before the pipeline; the agent's own events are
ignored. Reconnect with capped backoff and `since` = last event − 30 s (the
pipeline de-duplicates); `OK false` with a tag that no longer verifies stops
the socket (`failed`, `auth_tag_invalid`), otherwise it backs off and retries.
`receivers.buzz` reports the socket status.

Bridge sink (`program/src/channels/buzz-bridge.ts`, Coordinator conditions and
review M2/I1/I3):
installed while a Buzz identity exists (`receivers.sink: "buzz-bridge"`).
Each inbound route may carry the routed agent's Buzz key: `PUT
.../{channelId}/inbound {…, agentBuzzPubkey}` (npub or hex; `422
buzz_agent_key_invalid`, `409 buzz_relay_missing`), recorded in the additive
table `channel_buzz_route` with the Marketplace agent id and the relay URL it
was confirmed on. Any change of the agent on a Buzz-bound route needs the strict
owner gate (like `agentBuzzPubkey`) and the new agent's consent, and drops the
binding: nothing carries over (consent, bridge channel or key); until the owner
confirms the new agent's key nothing is bridged (`pending-bridge /
buzz_agent_key_missing`). A binding whose agent is not the routed agent is
refused at delivery (`bridge-failed / buzz_agent_changed`). Inputs are validated
before anything is written. Delivery:
no available identity → `pending-bridge / buzz_unavailable`; no agent key →
`pending-bridge / buzz_agent_key_missing`; identity relay ≠ the route's
confirmed relay → `bridge-failed / buzz_relay_changed` until the owner saves
the route again (a new relay or agent key forgets the bridge channel). Each binding gets
its bridge channel id when the owner confirms it; on first use the bridge checks
the relay for that id (kind 39002) and creates ONE private channel only if it
does not exist (kind 9007 `visibility=private`, name `tb-inbound-<channel
slug>`), so an uncertain create is never repeated as a second channel; then it
adds the agent key (kind 9000). Each message is a kind 9 from the bridge
identity with `p` = the routed agent only, a fixed provenance header (platform,
source channel id and title, thread id, message id, sender display and id, the
inbound event id for `marketplace.channels.reply`, attachment references, never
re-uploaded) and the text between `-----BEGIN UNTRUSTED EXTERNAL MESSAGE
<nonce>-----` and `-----END UNTRUSTED EXTERNAL MESSAGE <nonce>-----` with a
random per-message nonce. All normalisation (NFKC, control and zero-width
characters removed, mentions neutralised) happens before framing, and every
body line that normalises (NFKC, invisible characters removed, dash look-alikes
folded, case-folded) to a marker-like or header-like prefix is escaped with
`> `. Deliveries of one route are serialised. Retired bridge channels (re-bind,
relay change, key rotation) are recorded in the additive table
`channel_buzz_retired_group` and get the previous agent removed (kind 9001) on
the configured relay.

Retention: in the scheduler tick the bridge deletes its own bridged messages
older than the inbound text retention (one kind 5 per event; posts whose outcome
was uncertain are recorded too) and marks the rows of the additive table
`channel_buzz_bridged`; rows go after 90 days. Limits, stated plainly: a Buzz
kind 5 is a soft delete (the relay keeps the content with a deletion mark), and
messages left on a relay the owner no longer uses are not deleted there (rows
`skipped_relay_changed`: nothing is ever sent to a relay other than the
configured one). The owner screen says the same. Audit
`marketplace.channels.buzz.bridge_purged` with counts.

### Inbound (Channels P2)

The inbound worker receives messages for agents (P2 scope 2.2). Code:
`program/src/channels/inbound*.ts`, `discord-gateway.ts`, `teams-inbound.ts`.

Receivers (public routes at the Marketplace level, not manifest operations;
each is authenticated by the provider's own proof, with the Teams endpoint's
protections: exact path, a per-source budget and a cheap header check in
`onRequest` before the body is read, 128 KB body limit):

| Route | Purpose |
| --- | --- |
| `POST /api/marketplace/channels/slack/events` | Slack Events API. `X-Slack-Signature` v0 = HMAC-SHA256(signing secret, `v0:{timestamp}:{raw body}`), timestamp within ±5 minutes (`401 slack_signature_invalid` with `reason` `header_missing | stale | mismatch`). `url_verification` answers `{challenge}` after the signature check. Retries (`X-Slack-Retry-Num`) and the `message` + `app_mention` pair of one mention are de-duplicated by (channel, `ts`). No signing secret: `503 channels_slack_inbound_not_configured`. |
| `POST /api/marketplace/channels/telegram/webhook/{segment}` | Telegram webhook. `{segment}` is 32 random bytes (base64url) and `X-Telegram-Bot-Api-Secret-Token` 32 more; Marketplace stores only their SHA-256 (`channel_inbound_webhook`) and compares in constant time. Unknown segment `404`, wrong secret `401 telegram_secret_invalid`. Every update feeds the chats-seen table; message updates go to the pipeline (edits are not delivered again). |
| Discord gateway (outbound WebSocket) | In-process client over Node's built-in WebSocket: intents `GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES`, plus the privileged `MESSAGE_CONTENT` only when the owner turns on `discordMessageContent` (it must also be enabled for the bot in the Discord developer portal; without it Discord sends empty content except in DMs and mentions). Heartbeat with zombie detection, RESUME, op 7/9, capped backoff; close 4004 and 4010–4014 stop it (`failed` with a fixed reason). |
| `POST /api/marketplace/channels/teams/messages` | The existing Teams messaging endpoint: message activities now go to the pipeline. |

Capabilities (truthful, `channelCapabilities: 2`): Slack and Teams `inbound:
{mode: "webhook", dedupe: true}`, Telegram `webhook`, Discord and Buzz `socket`.

Owner switch (`PUT .../{channelId}/inbound`): the route `channelId → agentId`
is off by default. Enabling needs an active channel, a provider that declares
inbound, an agent that holds an active class consent (read or outward) for the
channel (`409 channel_inbound_agent_not_consented`), and per provider: Slack
the signing secret (`409 channel_inbound_signing_secret_missing`), Teams the
app credential, Discord the bot token. Telegram: the first enabled route calls
`getWebhookInfo` (a webhook of another host or path is another consumer of the
bot: `409 channel_consumer_conflict`), then `setWebhook` with the
`MARKETPLACE_PUBLIC_ORIGIN` URL (https, else `409
channel_inbound_public_origin_missing`), the secret token and `allowed_updates
[message, channel_post, edited_message, my_chat_member]`; the last disabled
route calls `deleteWebhook`. While a webhook is set `getUpdates` answers 409,
so Telegram discovery lists the chats seen by the webhook (with a note). In
groups with Telegram's privacy mode on, the bot receives only commands, replies
to it and mentions (turn privacy mode off in BotFather, or make the bot an
admin, to receive every message). Discord:
the gateway runs only while a Discord channel has an enabled route.
`browse` carries `inbound: {settings, routes, receivers}`.

Pipeline, in order: the bot's own messages are ignored; the message is matched
to an active Marketplace channel (provider + platform channel id; a Telegram
topic or Slack thread destination wins over the plain chat) with an enabled
route, else nothing is stored; de-duplication on (platform, platform channel
id, message id) in `channel_inbound_event`; loop breaker: at most 4
agent-bound events per thread and 8 per peer (sender) in 15 minutes, plus a
per-sender burst bucket (5, then one per 12 s) → `loop-limited` /
`rate-limited`; the routed agent's consent is re-checked (`consent-inactive`);
then `InboundSink.deliver(event, route)`. Without a Buzz identity the sink only
records (`bridge_status: pending-bridge`); with one, the Buzz bridge sink
delivers (see [Buzz](#buzz-channels-p2)). The audit event
`marketplace.channels.inbound.received` carries metadata only (event id,
platform, channel, outcome, routed agent), never text or sender names.

`channel_inbound_event` (additive): id, workspace, platform, channel id, thread
id, message id, sender user id, sender display (cleaned), text (untrusted,
cleaned by the parser, at most 8,000 characters, `text_truncated`),
attachments metadata (never bytes), route channel id, received at, routed to,
bridge status and detail, purged at. Other additive tables:
`channel_inbound_route`, `channel_inbound_reply`, `channel_inbound_setting`,
`channel_inbound_webhook`, `channel_consumer_lease`, `channel_telegram_chat`.

Agents: `marketplace.channels.inbound` lists the delivered events routed to
the caller on channels it still holds a consent for (newest first, `limit` ≤
100, cursor `before`), each with `framing: "untrusted-external-message"` and
`textFormat: "plain"` (entities are decoded, so clients render it as plain
text, never HTML), the
source ids (`source: {channelId, threadId?, messageId, senderUserId}`), the
sender, text, attachments metadata and `bridgeStatus`. It is the fallback for
agents without the Buzz bridge. `marketplace.channels.reply` takes the post
body (`text`, `attachments?`, `campaign?`) and replies natively: it runs the
normal post path (`executeConsentedCall`, outward consent for that channel,
standing grant or owner approval, caps, receipts) with `replyTo` = the thread
root (Slack, Teams) or the message (Telegram, Discord). A reply is digested
as `op: "reply"` with `replyTo` (plain posts keep `op: "post"` and their
digests), so an approval covers the reply target and never stands for a post.
A standing grant covers replies only with `scope.replies: true` (default false;
needs `immediate`; adding it is widening, so only a new owner approval grants
it; in the grant digest only when true, so existing grants are unchanged).
Without it every reply to an outside sender holds for the owner's approval of
the exact payload; a held reply keeps its target in
`channel_inbound_reply` under the internal key `inbound-reply:<key>`. Refusals:
`404 channel_inbound_event_not_found` (unknown, or routed to another agent),
`404 channel_not_found` (no consent), `403 channel_inbound_route_inactive`
(the owner disabled or moved the route), `403
channel_outward_consent_required`, `409 channel_idempotency_conflict`, and
every post refusal.

Consumer lease (spec §8): a bot token serves one inbound consumer. The Discord
gateway connects only while it holds `channel_consumer_lease`
`discord:<first 32 hex of sha256(token)>` (60 s, renewed every 20 s); while
another instance holds it the gateway waits (`waiting_lease`,
`consumer_conflict`) and it disconnects when it loses it. The lease works
between instances that share the data directory; a Marketplace with another
data directory on the same token is detected only for Telegram (the webhook
check above).

Retention: received text, sender display names and attachment names are
cleared after `textRetentionDays` (owner setting, default 30, 1–365) and the
metadata row is deleted after 90 days. Chats seen by the Telegram webhook
(chat id and untrusted title, also of chats without a channel: discovery needs
them) go after the same retention, at most 500 rows (oldest out). The purge
runs in every scheduler tick and, bounded, at start and on each owner browse,
so it also runs with the scheduler off or in inert mode (audit
`marketplace.channels.inbound.purged` with counts only).

### Routes v2 (Channels P2)

Reactions, edits, deletes, direct messages to named people, polls, markup and
named mentions. There is **one outward path**: every operation below is a
`channel_post` row through `executeConsentedCall` exactly like a post (consent
head, 3a channel and capability, 3b content, then the checks of this section,
3c authority, 3d caps, 3e idempotency, provider call, receipt, usage ledger and
audit). The agent's `Idempotency-Key` is prefixed per operation internally
(`msg-react:`, `msg-edit:`, `msg-delete:`, `person-dm:`), so a reaction, edit,
delete, DM and plain post never share a row. The action, person, mentions,
markup and poll are stored beside the post (`channel_post_op`, keyed like it)
so a held operation is rebuilt with the same payload at send time; the same key
with another body is `409 channel_idempotency_conflict`.

Digest (§4.6, additive; plain posts keep their digest): `op` (`post`,
`schedule`, `reply`, `poll`, `react`, `edit`, `delete`, `dm`), the destination
(`person:<platform user id>` for a DM, with `personId` and the `personName` the
owner approves), `targetMessageId`, `emoji` and `remove`, `text`, `markup`,
`mentions` (sorted by user id, with `name` when given), `poll` (question,
options in order, `allowsMultiple` when true, `durationHours`), attachments
(kind, sha256) and `replyTo`. Any change is a new digest and needs a new
approval.

Own messages only (review R3): a reaction, edit or delete names a message id
that Marketplace itself posted to THIS channel's current destination: the id is
in the sent-message ledger (`channel_sent_message`, written as soon as the
provider call returns) for that channel and destination, the post's kept
receipt (`sent` or `uncertain`) lists it, and the post is the calling agent's
own (spec 2.1; another agent's post or the owner test is not a target).
Anything else, a purged receipt or a destination changed since, is `404
channel_message_not_ours`, before any hold or provider call; a deleted message is `409 channel_message_removed`. A provider
window is respected at request time and again when an approved operation runs
(Telegram deletes: 48 h, refused 60 s early: `422
channel_delete_window_passed`; an approved hold past the window is skipped).

Body rules (refused before any hold, never cut): a reaction has an emoji (1-64
characters, the provider checks its own emoji set) and no text; an edit has
non-empty text; a delete has none; none of them takes attachments, mentions,
markup, a poll or a reply target. `mentions` needs `mentions.users` (Slack,
Discord, Teams, Buzz; ≤ 20 distinct ids; Teams also needs each `name` and an
`<at>name</at>` in the text). `markup` must be the default or one of
`markupOptions` (Telegram `markdown-v2`). `poll` needs `poll` (Telegram,
Discord), only on an immediate post, no attachments, inside the provider's
limits (`422 channel_poll_invalid`); its question and options pass the deny
patterns. The confirmed-event rule does not apply to reactions, edits, deletes
or DMs; every other content rule does.

Standing grants (review R4): new scope flags `reactions`, `edits`, `deletes`,
`polls`, `dms` (default false; `true` is wider, so `narrow` refuses adding one;
each needs `immediate`). A grant covers an operation only with its flag. The
grant digest includes a flag only when true, so grants approved before routes
v2 keep their digests.

Caps (Coordinator, 2026-10-10): reactions, edits and deletes never count against
the post caps (per day, per hour, minimum gap, one per phase; nor `usageToday`),
so an agent can delete a mistaken post at once. They have their own caps in the
channel ceiling, `caps.actions` (defaults and widest values: `reactionsPerDay`
100, `editsPerDay` 20, `deletesPerDay` 50, no gap; `editMinIntervalSeconds` 30,
at least 30, between two edits of the same message), counted for all agents in
the same reservation transaction, and optionally tighter in a grant's
`caps.actions` (an absent field inherits the ceiling; narrowing-aware; part of
the grant digest only when present). Refusals: `429
channel_cap_reactions_per_day | channel_cap_edits_per_day |
channel_cap_deletes_per_day | channel_edit_min_interval` with
`retryAfterSeconds`. Polls and direct messages are new outward content and stay
on the post caps.

People (review R5). The owner sets a people policy per connection (strict
owner gate: the pinned owner's own Portal launch session with CSRF; a plain
operator session is `403 owner_session_required`): `none` (default: no person
can be found or messaged), `allowlist` or `workspace` (anyone the connected
workspace or tenant can reach). An allowlist matches the person found by an
immutable platform id listed in `people` (Slack `U…`, Teams Entra object id,
Discord user id, Buzz npub or hex key) or, on Slack and Teams only, by the
verified email (or Teams user principal name) in `people` or its domain in
`domains` (Slack: only when the profile has `is_email_confirmed: true`;
otherwise only the user id matches); display names, nicknames and handles never
match. `channel-people.find`
runs server-side: `none` refuses before the platform is asked (`403
channel_people_disabled`); otherwise the platform is always asked and the
policy is checked after the lookup. No directory-membership leak: under an
allowlist, a person who exists but is not listed, an ambiguous match and nobody
all answer the same `404 channel_person_not_found` (same body, same platform
call); the real outcome (`not_allowed`, `not_found`, `ambiguous`) is only in the
audit metadata and the owner's `recentFinds` (in the people listing).
Finds are capped at 50 per agent per 24 h, the slot taken before the platform
call (`429 channel_person_lookup_cap`). People are **per agent**: the answer is
one opaque `personRef` (`prs_…`) that belongs to the calling agent (another
agent finding the same person gets its own), the display name to confirm and
`approved` for the caller's own approval only; a reference another agent
obtained is `404 channel_person_not_found`, the same as an unknown one. Never
a list (`404 channel_person_not_found`, `409 channel_person_ambiguous`). Slack
finds by email only; Discord and Buzz by handle; Teams by email or user
principal name (Graph flag); Telegram has no DMs (`422
channel_capability_unavailable`). The first message to a person is always held
for the owner's approval of the exact payload (a grant never covers it, even
with `scope.dms`), per agent; once that message is sent the person is approved
for that agent on that connection (`channel_agent_person.approved_at`) and that
agent's `scope.dms` may cover its later messages. The policy is checked again at
send time. The owner lists people per agent (with the platform id) and revokes
an approval per (agent, person) (strict owner gate; that agent's next message is
held again). Sent-message rows are purged with their receipts in the scheduler
tick. Audit records the
query kind and outcome, never the email or handle.

Owner views: the Approvals queue and `channel-posts.list` carry `action`:
`{op, emoji?, remove?, targetMessageId?, targetExcerpt?}` (the first 200
characters of the target's kept receipt text) or `{op: "dm", person:
{displayName, approved}}`; the approval `actionKey` is `channel.react|edit|
delete|dm`, and the held operation for a Portal assertion `op` is the matching
manifest operation.

Self-loop (review R8): Telegram can deliver the bot's own channel post to the
webhook before `sendMessage` answers. The receiver waits (at most 10 s) for
sends to the same chat that are still in flight, then checks the message id
against the sent-message ledger and receipts of the last 48 hours; the loop
breaker's per-sender cap stays as the last guard.

### Live sessions (Channels P2)

Buzz huddles under a **live-session grant** (scope §2.3, contract alpha.8 `@tealbrick/contract/grants`). Buzz declares
`live: {join, listen, speak, transcript, maxSessionMinutes: 120}`; `live.join|listen|speak|transcript` are wired.

Grant. The agent proposes `{huddleId?, modes: {listen?, speakApproved?, speakLive?}, maxSessionMinutes ≤ 120,
maxDayMinutes, costCap.providerMinutes, topic, forbiddenTerms?, consent?: {disclosureNotice (default true),
perParticipantConsent (default false)}, caps?: {perDay (default 10), perHour?, minIntervalSeconds?}, expires}` for a
channel it holds an `outward` consent for. Marketplace builds the canonical grant (fresh id `live-<16 hex>`, a
description naming the agent and channel, target = the Buzz channel or one huddle), checks it with `parseGrant`,
`assertServerEnforceable` and `grantApprovalWindow` (≤ 30 days after approval) and stores `canonicalGrant` and
`grantDigest` (`sha256("tealbrick-grant/v1\n" + canonical)`) in `channel_live_grant`. `experts` and `deny` are
refused (the server cannot enforce them). Two open grants never share a 32-hex digest prefix.

Approval (owner only, exactly the digest): the Marketplace UI (`approve` with the shown `digest`, pinned owner's
launch session); a Buzz reply `approve grant <32+ hex>` signed by the pinned owner Buzz key and posted in the grant's
own Buzz channel (the channel comes from the grant record, never from the request); or a Portal owner assertion with
`op: "tealbrick:standing-grant"`, `approvalId` = grant id, the digest and the pinned `ownerSubject`. Both proofs go
through `verifyGrantApproval`, are single use instance-wide (`marketplace_used_approval_proof`) and Marketplace stores
`result.canonical` as returned. A Buzz proof signed before the current owner key was set is refused. Any change (agent
or owner narrowing) is a new digest and needs a new approval; nobody widens. The agent may only make the consent flags
stricter; the owner may set them either way. Owner revoke/pause/resume: the UI, or a forwarded owner-signed
`revoke <grant-id>` (in that grant's channel) / `pause grants` / `resume grants` (in the owner command channel set in
the UI), verified with `verifyOwnerCommand`.

Session. `join` needs the caller's active grant covering every requested mode, the `outward` consent, the Buzz
identity, and room under the caps (joins per day/hour/interval, minutes in the rolling day, provider minutes). With
`consent.disclosureNotice` the notice (kind 9) is posted in the huddle's parent channel first; if it fails nothing
joins. `listen` is refused while `perParticipantConsent` is true (no per-participant gate yet) and while no speech
provider is wired. Every 250 ms the session re-reads the grant record, the owner switch, the consent and the channel;
revoke, pause, expiry, narrowing, consent loss, channel pause, `maxSessionMinutes`, `maxDayMinutes` and the cost cap
stop it, and the client leaves within 5 s. `speak`: `{attachmentId}` of an uploaded `audio/ogg` clip is held once in the
approvals queue (`live.speak-clip`, digest `sha256("tealbrick-live-clip/v1\n" + grantId + "\n" + clipSha256)`, owner
approval in the UI, Buzz or TBD) and plays after approval; `{text}` (speak-live) refuses forbidden terms before any
provider call and is refused (`live_tts_unavailable`) until `@tealbrick/voice` ships Ogg/Opus synthesis (rc.19).

Receipts. `channel_live_transcript` keeps what the agent heard (other participants: `framing:
"untrusted-external-speech"` with the speaker key; forbidden terms flagged, never refused) and said (text, or the
SHA-256 of an approved clip), with times; text is emptied after the inbound text retention. Sessions keep join and
leave times and minutes. Raw audio is never written anywhere. The audit gets metadata and SHA-256 only (the session
end records the transcript digest).

### Inert mode

Without any channel credential (no token in the environment or in
`connector_secret`), Channels is inert: the scheduler timer is not started,
every channel operation except the owner browse answers `409
channels_not_configured`, the browse answers `{configured: false, providers:
[{id, readiness: "credential_missing"}]}`, and `/api/portal/readiness` has no
`channels` block. The channel tables are created (additive) and stay empty.
No inbound receiver starts: no gateway connection, no webhook call; the Slack
events route answers `503 channels_slack_inbound_not_configured` and the
Telegram webhook route `404` after their cheap checks. The Buzz identity
operations still work (the identity is what turns Buzz on); a first identity
takes effect after the next start, and no relay connection or post happens
before.

### Send-time rules

At send time (immediate, owner-approved, scheduled) the reservation
transaction re-checks that the channel is active, the consent row is active
and, under a standing grant, the grant is active (`409 channel_paused |
consent_inactive | grant_inactive`), so a pause or revoke during the
send-time awaits stops the send. A definitive refusal of an owner-approved
hold (caps, content, digest mismatch, paused channel, revoked consent) ends it
`skipped` and fails the approval; the agent must ask again. A transient one
(`503 channel_event_check_unavailable | channel_credential_unavailable`, `409
channel_connection_unavailable`) keeps an immediate hold and its approval for
a retry with the same key. The owner may deny an approved approval while its
post is still held. The digest also covers the destination `parentId`; a
destination change suspends the channel's grants and ends its holds
(`destination_changed`).

Uploads: the bytes must match the declared content type (PNG, JPEG, WebP, GIF,
PDF, OGG, MP3, MP4/M4A, ZIP, UTF-8 text) and the file name extension must
belong to it (`422 channel_attachment_type_mismatch`);
`application/octet-stream` is accepted only where a provider declares it and is
never re-typed.

Attachment quota and cleanup: each agent may keep at most 200 MiB of stored
attachments per workspace and upload at most 50 files in any 24 hours (`429
channel_attachment_quota_exceeded` with `limit: bytes | uploads_per_day`,
checked in the upload transaction before any byte is written; a refused key
may be retried). The scheduler tick (only when Channels is configured) deletes,
in batches of 100, attachments no post references after 24 hours, and
attachments of finished posts once their receipts are purged or after the
90-day receipt retention. An attachment used by a post that is not finished
(`held`, `scheduled`, `sending`, `uncertain`) is never deleted; a file goes
with the last row of its SHA-256.

A held post whose approval ended without an approval (`failed`, for example
decided in an older Marketplace during a rollback) is ended by the next tick as
`skipped` with reason `approval_failed` and a receipt; it is never sent. The
agent's retry with the same key answers `409 approval_failed`.

Receipt purge (owner op and the 90-day retention in the tick) deletes only
receipts of finished posts and answers `{purged, skipped}`.

Resolve: a proof is verified only against a pinned owner (the hold's owner
Buzz key for `nostr`, the claim binding's `ownerSubject` and grant JWKS for
`portal`); without the pin the answer is `503 approval_owner_unbound` before
any verifier runs.

### Scheduler

In-process, every 30 s (`channelScheduler: false` disables it). Each tick:
rows stuck in `sending` past their lease become `uncertain` (never re-sent);
due `scheduled` rows are claimed with a guarded update (claimer + 120 s lease,
taken over only after expiry) and rechecked at send time (consent, grant,
channel, content, digest); held scheduled posts are sent if approved or expire;
any refusal is `skipped` with the reason; more than 15 minutes late is
`expired`.
