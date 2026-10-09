# Teal Brick miniapp contract

Marketplace follows the Teal Brick miniapp contract (`tealbrick.miniapp/v1`,
kit `@tealbrick/contract` pinned at `0.1.0-alpha.6`). The manifest is
`tealbrick.app.json` at the repository root. It is validated at start-up and
served at `/.well-known/tealbrick/manifest`. Validate it in CI with:

```sh
npx -y @tealbrick/contract@0.1.0-alpha.6 validate tealbrick.app.json
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

* `GET` → `{instanceId, publicJwk}`.
* `POST {portalIssuer, nonce, companyId, jwksUri?, grantKids?}` → `{proof}`, an
  EdDSA `tealbrick-app-claim` v1 JWT with exactly `typ`, `version`, `aud`
  (= `portalIssuer`), `nonce`, `instanceId`, `companyId`, `iat`, `exp`
  (`exp - iat` = 300 s).
* Credential: a custom kit `CredentialVerifier` that applies the legacy claim
  rule (internal token or `TEALBRICK_INSTANCE_TOKEN` as Bearer or
  `x-knowledge-instance-token`, or the Portal instance proof in
  `x-tealbrick-instance-proof`, constant time). The kit refuses any request
  with `Origin` or `Cookie`.
* `companyId` must equal `MARKETPLACE_ORGANIZATION_ID` (else the Portal
  workspace binding); the issuer must equal the configured Portal issuer
  (`claim.issuers`).
* The claim key and instance id are the ones in
  `instance-claim-identity.json`, shared with the legacy route. The binding and
  the grant trust anchors are kept in `instance-claim-binding.json` (the kit's
  `ClaimStore`), ready for `l2GrantOptionsFromClaim`.

Contract alpha.7 adds the `x-tealbrick-contract` answer header on `GET` and
`ownerSubject` in the `POST` body. Kit alpha.6 refuses a body with
`ownerSubject` (`400 invalid_claim_request`), so Marketplace needs the kit bump
before Portal Core sends it.

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
channel). Every send goes through `executeConsentedCall` (C1): the shared head
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
| `marketplace.approvals.resolve` | `POST /api/marketplace/v1/agent/approvals/{approvalId}/resolve` | writes-app-state | required (`resolve.<approvalId>.<decision>`) |

Consent: a Portal v1.4 class grant `{pluginId: channels-<provider>, accountId:
<connectionId>, resourceKind: <provider>.connected-account, resourceRef:
account:<connectionId>, grantClass, actionGroup: channel:<slug>}`. `outward`
is needed to post, schedule, cancel, upload and propose; `read` suffices for
list, get, receipts and grants. A channel without such a consent for the
caller answers `404 channel_not_found`, the same as an unknown channel.
Marketplace requires the `actionGroup` (a whole-connection class consent does
not reach channels in P1).

Post body: `{text, attachments?: [{attachmentId, kind, transcript?}],
campaign?: {ref?, phase?}}` (`schedule` adds `sendAt`, now + 60 s to now + 30
days). `kind` is `image|file|audio|voice|video` and must be declared by the
channel's provider. Declared fallbacks (Discord voice → audio + `Transcript:`
line) are applied before the content rules and before the digest, so a
transcript passes the same deny patterns and the owner approves exactly what is
sent. Attachments must be the caller's own uploads; unknown or foreign ids are
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
  response header and the trace id in `X-Trace-Id`. No grant covers the post,
  so it waits for the owner in the existing approvals queue. Retry with the same key; after the owner approves,
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
approval_owner_key_changed`,
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

* `nostr`: `verifyNostrApprovalProof` with the forwarded event and `channel`
  (the event's `h` tag must equal it), the held digest (`approve <12+ hex
  prefix>`), age ≤ 15 minutes, kind 9, recomputed NIP-01 id, BIP-340
  signature, and the owner key **pinned on the hold at creation**. That key
  must still be the current owner key (same fingerprint and epoch); otherwise
  `409 approval_owner_key_changed` (also for a hold created before any key
  was set). An event signed before the current key was set is `403
  approval_proof_invalid` (`reason: key_changed`). No key: `503
  approval_owner_unbound`. When Portal attests the owner's key (v2) and it
  differs from the owner setting: `503 approval_owner_key_mismatch`.
* `portal`: `verifyOwnerApprovalAssertion` with the issuer-pinned grant JWKS
  of the claim binding (`ownerApprovalOptionsFromClaim`: pinned issuer,
  `jwksUri`, grant kids), `aud = tealbrick-app:<claimed instanceId>`, `dep` =
  own deployment id, `sub` = the pinned `ownerSubject`, `approvalId`,
  `digest`, `op` (the held operation: `marketplace.channels.post` /
  `.schedule`, or `marketplace.tools.call`), `agent =
  tealbrick-agent:<agentId>`, `decision`, `exp − iat ≤ 300 s`, single-use
  `jti` (kept until `exp`). Type separation: an L2 grant JWT is `403
  approval_proof_invalid` (`reason: wrong_header_type`). The assertion's
  `amr` and `device` claims are stored on the approval record (metadata;
  shown in the owner view as `proof`). An unreachable JWKS is `503
  approval_proof_unavailable`.

Refusal reasons (`reason`): `wrong_channel`, `wrong_owner`, `bad_signature`,
`stale`, `not_yet_valid`, `wrong_digest`, `digest_prefix_too_short`,
`ambiguous`, `wrong_kind`, `bad_id`, `key_changed`, `malformed` (nostr); the
contract `OwnerApprovalDenialReason` values (portal). A replayed proof of
either type is `409 approval_proof_reused`.

Owner pin. The owner comes only from the contract claim binding (alpha.7:
`ownerSubject`, `ownerPinnedAt`; re-pinned only by a newer claim, cleared by
a claim without it), read through `channels/owner-pin.ts`. The Portal launch
credential's `ownerSubject` is never used to authorize a caller or to re-pin.
Marketplace still answers the legacy claim path, so today nothing is pinned
and `portal` proofs answer `503 approval_owner_unbound`; the pin starts
working when the manifest-claim handler passes its `claim.store` as
`ownerPinSource`. Installed contract alpha.6 takes `ownerUserId`; the adapter
strips `tealbrick-user:` from `ownerSubject` (alpha.7: pass `ownerSubject`).

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
| `marketplace.approval-owner-key.get` | `GET /api/marketplace/approvals/owner-key` → `{ownerKey: {setting, fingerprint, ownerKeySource: owner-session|portal-attested|null, ownerKeyStatus: unset|ok|mismatch, attestedFingerprint, setAt}}` |
| `marketplace.approval-owner-key.update` | `PUT /api/marketplace/approvals/owner-key` `{pubkey}` → `{changed, invalidatedHolds, ownerKey}` |
| `marketplace.approval-owner-key.clear` | `DELETE /api/marketplace/approvals/owner-key` → `{changed, invalidatedHolds, ownerKey}` |

* Writes need the owner's own operator session from a Portal launch ticket,
  with its CSRF token (checked by the route itself). Refused (`403
  owner_session_required`, or earlier `401`/`403`): agents (`tbag_`, as
  owner operations), runtime leases, the service bearer, the settings relay
  bearer, the emergency session, the operator access-token session and the
  test bypass. When the claim binding pins the owner, the launch user must be
  that owner.
* Format: 64 hex characters (either case; stored lowercase) or a NIP-19
  `npub1…` (bech32, checksum verified). `nsec`, other prefixes, whitespace and
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
  `ownerKeyStatus: "mismatch"` (Buzz proofs refused, fail closed).

### Owner operations (`audience: owner`)

| Operation | Route |
| --- | --- |
| `marketplace.channels.browse` | `GET /api/marketplace/channels` (`configured`, `providers` with each configured provider's static capability declaration and kinds, channels, readiness, connections, pending grants, uncertain posts) |
| `marketplace.channels.discover` | `GET /api/marketplace/channels/discover?provider=` |
| `marketplace.channels.create` | `POST /api/marketplace/channels` (Idempotency-Key; destination from discovery only; optional `kind`, only kinds the provider serves, else `422 channel_kind_unsupported`) |
| `marketplace.channels.update` | `PATCH /api/marketplace/channels/{channelId}` (bumps `revision`, re-checks grants) |
| `marketplace.channels.pause` / `.resume` / `.archive` | `POST /api/marketplace/channels/{channelId}/pause|resume|archive` |
| `marketplace.channels.test` | `POST /api/marketplace/channels/{channelId}/test` (fixed text, authority `owner-test`) |
| `marketplace.channel-grants.approve` / `.decline` / `.revoke` | `POST /api/marketplace/channels/grants/{grantId}/approve|decline|revoke` (approve takes an optional narrower `final`) |
| `marketplace.channel-posts.list` | `GET /api/marketplace/channels/posts?status=held,scheduled,uncertain&channelId=` (send time, channel, agent, digest prefix, approval state; no text) |
| `marketplace.channel-posts.cancel` | `POST /api/marketplace/channels/posts/{postId}/cancel` (scheduled posts; closes a waiting approval, fails an approved one) |
| `marketplace.channel-posts.resolve` | `POST /api/marketplace/channels/posts/{postId}/resolve` `{status: sent|failed}` |
| `marketplace.channel-receipts.export` / `.purge` | `GET /api/marketplace/channels/receipts/export`, `POST /api/marketplace/channels/receipts/purge` `{olderThanDays}` (default 90; finished posts only; answers `{purged, skipped}`) |

"Grant to agent" is `marketplace.consents.request` with the channel's class
selection (each channel in `browse` carries it as `grantSelection`, with the
display-only `actionGroupLabel`, plain text of at most 80 characters, which
Portal never stores and Marketplace never persists). Per-payload approvals are
the existing `marketplace.approvals.*` queue; channel holds show the channel,
the digest and, on `get`, the exact payload view.

### Credentials and readiness

Bot tokens come from `MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN` and
`MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN` (settings group `channels`,
account-sourced provider env, read at start), or self-hosted from the encrypted
`connector_secret` `botToken` under `channels-<provider>`. Each is verified once
at start; the connection row keeps only `{botId, botUsername, verifiedAt,
credentialRef}`. Readiness per provider (`available | credential_missing |
credential_invalid | unavailable`) is in `browse` and in
`/api/portal/readiness` (`channels.providers`). Tokens are never in responses,
receipts, rows, logs, audit or errors; provider text is redacted before it is
written.

### Inert mode

Without any channel credential (no token in the environment or in
`connector_secret`), Channels is inert: the scheduler timer is not started,
every channel operation except the owner browse answers `409
channels_not_configured`, the browse answers `{configured: false, providers:
[{id, readiness: "credential_missing"}]}`, and `/api/portal/readiness` has no
`channels` block. The channel tables are created (additive) and stay empty.

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
