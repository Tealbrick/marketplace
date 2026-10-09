# Marketplace Channels (spec v0.2)

Status: accepted by Coordinator · Teal Brick 2026-10-09, with conditions (one approval experience §6; standing grants §4.4; TypeScript only; bot tokens only via Account Connections, entered by Martin; Henry cutover is Martin's go). Owner: Lead · Channels (a lane inside the Marketplace miniapp). Code review: Lead · Miniapps. Approval: Coordinator · Teal Brick.
Builds on: the Marketplace consent and `executeConsentedCall` path ([contract.md](contract.md)), Portal class grants (`operator-handoff.v1.4`), the miniapp contract §12 (Forge `projects/tealbrick/decisions/tealbrick-miniapp-development-contract.md`), the engine adapter pattern in the miniapps PRD §2, and the kit 0.3.0-rc.13 outward gate.
Build plan: [channels-build-plan.md](channels-build-plan.md).

## 1. Problem and goal

A **channel** is an outward communication surface: a Telegram chat, a Discord channel, a Slack channel, an X account, a LinkedIn Page, a Listmonk list, an email sending identity, a community forum category. Today these are either arguments that an agent passes to a generic connector, or one agent's private host tools (Henry's `henry_bots`, `henry_mail`). Nothing records which destinations a workspace owns, which agent may use which one, the posting rules, the rate, or the receipts.

Goal: Channels is a first-class part of Marketplace. Any agent in a workspace uses a channel through the **same Portal grant, the same owner approval queue and the same execution path** as every other connector. The policy lives in Marketplace, not in an agent's tools. Henry's host tools are interim and are retired per §11.

## 2. Model

```
Connection (one credential per provider per workspace)
   1──n  Channel (destination + policy ceiling)
            n──n  Agent consent (Portal class grant, actionGroup = channel:<slug>)
            1──n  Standing grant (agent proposes, owner approves, narrowing only)
            1──n  Post (immediate or scheduled) ──1 Receipt
```

Invariants:
- **C1 One path.** Every send goes through `executeConsentedCall`: consent → policy → owner approval or standing grant → idempotency → executor → usage ledger → audit. Native adapters are execution targets of that path. There is no parallel send path.
- **C2 Narrowing only.** Effective authority = Portal consent ∩ channel policy ceiling ∩ standing grant (if any) ∩ provider limits. No layer can widen another.
- **C3 Outward by default.** Every operation that puts content in front of a third party is outward. Without an active standing grant that covers the exact post, it waits for the owner's approval of the exact payload digest.
- **C4 Credentials never reach agents.** Tokens are not in prompts, responses, receipts, logs, audit or error reports.
- **C5 No emulation.** An operation that a provider adapter does not declare returns `channel_capability_unavailable` (PRD §2.1 A2).
- **C6 Real identities only.** Bot accounts, Pages, organisation sending addresses. No fake person accounts. Platforms without an API are out of scope (§12).

## 3. Channel types and providers

| Kind | Destination | Providers (phase) | Executor |
|---|---|---|---|
| `chat` | chat, group, channel, forum topic, thread | Telegram (P1), Discord (P1), Slack (P2), LINE OA, WhatsApp Cloud (later) | native |
| `newsletter` | one list (optionally a segment) | Listmonk (P2) | native |
| `email` | one sending identity + recipient allowlist | SMTP or Resend (P2), Gmail via Clerk token (later) | native |
| `social` | one account or Page | X, LinkedIn Page, Facebook Page, Instagram (P3) | composio |
| `community` | one forum category | Discourse (P3) | native |

### 3.1 Provider capability declaration (pattern from PRD §2.2)

Each provider adapter declares what it can do. **Static** in the manifest (`channels.providers[]`), **live** in readiness (`/readyz` and the Channels UI): `available`, `credential_missing`, `credential_invalid`, `paused`, `unavailable`. A live capability never exceeds the static one. Portal and the UI derive options from these values only.

Closed vocabulary (`channelCapabilities: 1`):

| Key | Values |
|---|---|
| `send.text` | bool |
| `send.maxChars` | integer (Telegram 4096, caption 1024; Discord 2000; …) |
| `send.files` | `{types: [...], maxBytes, maxCount}` or `false` |
| `send.markup` | `plain` \| `markdown` \| `html` |
| `send.mentions` | `suppressed` (always for broadcast mentions: `@everyone`, `@here`, `@channel`) |
| `edit`, `delete` | bool (P2) |
| `schedule.native` | bool (provider-side scheduling, e.g. Slack `chat.scheduleMessage`) |
| `events.create` | bool (Discord guild scheduled events, P2) |
| `discover` | `updates` \| `list` \| `manual` |
| `inbound` | `webhook` \| `poll` \| `gateway` \| `none` |
| `audience.count` | bool |
| `limits` | `{perChatPerSecond?, perChatPerMinute?, retryAfter: honoured}` |

A text over `send.maxChars` is refused with `channel_text_too_long`. It is never silently cut (Henry lesson: Discord truncation, Telegram caption split).

## 4. Records

### 4.1 Connection (existing `connector_connection`)

One row per (workspace, `channels-<provider>`), `backend: native` or `composio`. `metadata` holds the bot identity only (`botId`, `botUsername`, `verifiedAt`) and a `credentialRef` (`provider-env:<NAME>`, `marketplace-secret:<id>` or `composio:<provider>:<connectedAccountId>`). v1 allows one credential per provider per workspace; one Telegram or Discord bot already reaches many destinations. More credentials per provider are a later additive change (indexed setting slots).

### 4.2 Channel (`channel`)

| Field | Meaning |
|---|---|
| `id`, `workspaceSlug`, `slug`, `label` | `slug` is `^[a-z0-9][a-z0-9-]{1,47}$`; used in `actionGroup` |
| `kind`, `provider`, `connectionId` | §3, §4.1 |
| `destination` | `{type, externalId, title, url?}`, picked from discovery, never typed by an agent |
| `audience`, `language`, `purpose` | Text shown to agents in `channels.list` and to the owner |
| `policy` | Ceiling, §4.3 |
| `status` | `draft`, `active`, `paused`, `archived` |
| `revision` | Increments on each policy change |

### 4.3 Channel policy (owner-set ceiling)

| Field | Default (from Henry's tested caps) |
|---|---|
| `standingGrants` | `disabled`. When `allowed`, agents may propose standing grants for this channel |
| `caps.perDay` / `caps.perHour` | 6 / unset. Shared by **all** agents on this channel |
| `caps.minIntervalSeconds` | 600 |
| `caps.onePerPhase` | true: one post per (channel, campaign ref, phase) |
| `content.maxChars` | provider `send.maxChars` |
| `content.files` | `{allowed: true, types: png,jpeg,webp,pdf, maxBytes: 10 MiB, maxCount: 4}` ∩ provider |
| `content.requireConfirmedEvent` | false. When true, `campaign.ref` must be `https` on `content.listingHosts` (exact host or subdomain suffix) and answer HTTP 2xx at send time |
| `content.denyPatterns` | Case-insensitive substrings that refuse a post |
| `schedule.window` | Optional local-time window with time zone (no posts outside) |
| `recipients` (email only) | Allowlist of exact addresses and `@domain` entries. Other recipients: draft only |

### 4.4 Standing grant (`channel_standing_grant`)

A standing grant replaces per-post approval for a bounded set of posts by one agent on one channel. It never replaces the Portal consent.

| Field | Meaning |
|---|---|
| `id`, `channelId`, `agentId`, `consentId` | The grant is bound to the consent that was active when proposed |
| `purpose` | 1–300 chars, shown to the owner ("weekly meetup announce/reminder/recap") |
| `caps` | `{perDay, perHour?, minIntervalSeconds, onePerPhase}`, each ≤ the channel ceiling |
| `scope.phases` | Subset of `announce`, `reminder`, `recap`, `update`, or unset (any) |
| `scope.campaignRefs` | Optional globs on `campaign.ref` (e.g. `https://lu.ma/*`) |
| `scope.files` | `false` or a subset of the channel file policy |
| `scope.maxChars` | ≤ ceiling |
| `scope.immediate`, `scope.scheduled` | Which post modes the grant covers |
| `notBefore`, `expires` | `expires` is required and ≤ 90 days after approval |
| `status` | `proposed`, `active`, `suspended`, `withdrawn`, `revoked`, `expired`, `declined` |
| `digest`, `approvedBy`, `approvedAt`, `approvalSource` | SHA-256 of the canonical grant; `approvalSource` = `marketplace-ui` or `buzz-signed` |

Lifecycle and rules:
1. **Propose (agent).** `marketplace.channels.grants.propose` creates a `proposed` row. A proposal wider than the channel ceiling, or on a channel with `standingGrants: disabled`, is refused (`422 grant_exceeds_ceiling`, `409 standing_grants_disabled`). A proposal never authorises anything.
2. **Approve (owner only).** In the Marketplace Approvals view, or by a signed owner Buzz reply `approve <12+ hex digest prefix>` (P2). The owner may approve as proposed or **narrow** any field before approval. The owner cannot widen a proposal; to allow more, the agent proposes again. Approval binds the digest of the final grant.
3. **Narrow or withdraw (agent).** `grants.narrow` accepts only a subset of the current grant (any widening: `422 grant_widening_refused`). `grants.withdraw` ends it.
4. **Revoke (owner).** Any time, effective immediately.
5. **Automatic suspension.** A grant is `suspended` when its consent is revoked or no longer active, the channel is paused or archived, or the channel ceiling is lowered below the grant. Effective caps are always `min(grant, current ceiling)`; a suspended grant resumes only by a new approval.
6. **Counters.** Caps are counted from `channel_post` rows inside the same SQLite write transaction that reserves the post (no read-then-append race). `sent` and `uncertain` posts count; `failed` and `skipped` do not.

Single source of truth: the Marketplace DB holds channel policy and standing grants. The kit's `native-serve.json` standing grants stay a harness-local, defence-in-depth layer and must not carry channel caps.

### 4.5 Post (`channel_post`) and attachment (`channel_attachment`)

`channel_post`: `id, channelId, agentId, consentId, mode (immediate|scheduled), sendAt?, text, attachmentIds, campaign {ref?, phase?}, digest, authority (grant:<id>|approval:<id>), status, idempotencyKey`. Status: `held`, `scheduled`, `sending`, `sent`, `failed`, `uncertain`, `skipped`, `cancelled`, `expired`.

`channel_attachment`: uploaded bytes in `/data/channels/attachments/<sha256>`, with `sha256, contentType, bytes, name, createdBy`. Retention follows the receipt (§7).

### 4.6 Payload digest

`digest = sha256(canonicalJson({v: 1, workspace, channelId, provider, destination: externalId, op, text, attachments: [{sha256, contentType, name}], campaign, sendAt?}))`, with the kit `canonicalJson` (sorted keys, no whitespace, undefined dropped, arrays in order). The digest binds the tenant, the destination and the exact file bytes (the kit digest binds only tool and input). The owner sees the full payload, image previews and file hashes before approving. Any change after approval needs a new approval.

## 5. Operations (`tealbrick.miniapp/v1` manifest additions)

`effects` uses the contract vocabulary (`read-only`, `writes-app-state`, `external-effects`). Marketplace risk classification marks every `external-effects` channel op as **outward**. Paths are under `/api/marketplace/v1/agent/channels` (agent) and `/api/marketplace/channels` (owner).

### 5.1 Agent audience

| Operation | Method, path | CRUD | Effects | Idempotency | Notes |
|---|---|---|---|---|---|
| `marketplace.channels.list` | GET `/` | read | read-only | — | Only channels this agent has a consent for: label, purpose, audience, capabilities, effective caps and usage today, own grants |
| `marketplace.channels.get` | GET `/{channelId}` | read | read-only | — | 404 for channels without consent (same as unknown) |
| `marketplace.channels.attachments.upload` | POST `/attachments` | create | writes-app-state | required | Raw bytes, ≤ channel/provider limits; returns `{attachmentId, sha256}`. Not outward |
| `marketplace.channels.post` | POST `/{channelId}/posts` | create | external-effects | required | `{text, attachmentIds?, campaign?}` → `200 receipt` or `202 approval_pending` |
| `marketplace.channels.schedule` | POST `/{channelId}/scheduled` | create | external-effects | required | Same body + `sendAt` (≥ now + 60 s, ≤ 30 days) |
| `marketplace.channels.scheduled.cancel` | POST `/{channelId}/scheduled/{postId}/cancel` | update | writes-app-state | supported | Own posts only. Cancelling is narrowing; it never needs approval |
| `marketplace.channels.receipts.list` | GET `/receipts` | read | read-only | — | Own receipts only |
| `marketplace.channels.grants.list` | GET `/grants` | read | read-only | — | Own grants and their state |
| `marketplace.channels.grants.propose` | POST `/{channelId}/grants` | create | writes-app-state | required | Creates `proposed`; §4.4 |
| `marketplace.channels.grants.narrow` | POST `/grants/{grantId}/narrow` | update | writes-app-state | required | Subset only |
| `marketplace.channels.grants.withdraw` | POST `/grants/{grantId}/withdraw` | delete | writes-app-state | supported | |
| `marketplace.approvals.resolve` | POST `/api/marketplace/v1/agent/approvals/{approvalId}/resolve` | update | writes-app-state | required | Forwarded by the kit (K1): the owner-signed approval event for the caller's own held call (§6). Not a channel-only op; it also serves held `tools.call` calls |

Later phases: `marketplace.channels.events.create` (Discord scheduled event; create; external-effects; P2), `marketplace.channels.read` (recent inbound messages; read; read-only; P4).

### 5.2 Owner audience (`audience: "owner"`, §12.8: never exposed to a harness, never granted to an agent or companion)

| Operation | CRUD | Effects | Purpose |
|---|---|---|---|
| `marketplace.channels.discover` | read | read-only | Destinations the provider credential can reach (Telegram updates after the owner writes one message in the chat; Discord guild channels; Slack `conversations.list`; Listmonk lists) |
| `marketplace.channels.create` / `.update` | create / update | writes-app-state | Channel and policy ceiling. Each policy change bumps `revision` and re-checks grants (§4.4 rule 5) |
| `marketplace.channels.pause` / `.resume` / `.archive` | update / update / delete | writes-app-state | Archive is soft; receipts remain |
| `marketplace.channels.test` | create | external-effects | Sends a fixed test text after the owner clicks; shows the receipt |
| `marketplace.channels.grants.approve` / `.decline` / `.revoke` | update | writes-app-state | §4.4 |
| `marketplace.channels.posts.resolve` | update | writes-app-state | Marks an `uncertain` post `sent` or `failed` after the owner checks the destination |
| `marketplace.channels.receipts.export` / `.purge` | read / delete | read-only / writes-app-state | Retention (§7) |

Per-payload approvals reuse the existing `marketplace.approvals.list|get|approve|deny` operations and queue. No new approval op.

### 5.3 Portal grant mapping (no Portal schema change)

A channel consent is a v1.4 **class grant**: `pluginId: channels-<provider>`, `accountId: <connectionId>`, `resourceKind: <provider>.connected-account`, `resourceRef: account:<connectionId>`, `grantClass: outward` (post, schedule) or `read` (list, get, receipts, P4 read), `actionGroup: channel:<slug>`. Marketplace is already authoritative for expanding class + group to operations. Without `actionGroup` the consent covers every channel on that connection; the Channels UI always sends one. The owner starts the request from the Channels view ("Grant to agent"), and Portal shows its normal consent dialog, labelled from the display-only `actionGroupLabel` that Marketplace adds to the grant-review answer. Tether actions: `read, create` for outward (v1.4 table).

## 6. Execution flow

1. Grant guard: the `tbag_` grant maps the route to a manifest operation (existing preHandler). Owner ops refuse agents (`operation_owner_only`).
2. Resolve channel + consent: the agent's active consent whose selection matches `channels-<provider>` / connection / `channel:<slug>`; otherwise 404.
3. `executeConsentedCall` with that selection (C1). Inside it, the channel policy engine runs in this order, and nothing is consumed before all checks pass (fixes Henry's "approval spent on a refused post"):
   a. channel `active`, connection `connected`, provider capability present (C5);
   b. content rules: length, files, deny patterns, confirmed event (live check at send time), schedule window;
   c. authority: an `active` standing grant whose scope covers this post → `authority = grant:<id>`; else an owner approval for this exact digest → `authority = approval:<id>`; else hold (`202 approval_pending` with `approvalId` and digest prefix) through the existing `holdCompanyBoxCall` queue, generalised to channel listings;
   d. caps: channel ceiling and grant caps, counted and reserved in one `BEGIN IMMEDIATE` transaction;
   e. idempotency: `marketplace_runtime_operation` (`UNIQUE(consent_id, idempotency_key)`), existing replay and conflict semantics.
4. Executor target `channel-native` (Telegram, Discord, …) or `composio`. HTTP 429: honour `retry_after` once if ≤ 30 s, then `failed`. Timeout or abort after the request left: `uncertain` (counts for caps, blocks retry of the same post until the owner resolves it).
5. Receipt, `recordUsage` (shapes only), `recordEvent` (metadata + content SHA-256, §12.8).

**Scheduled posts.** `channels.schedule` runs steps 1–3c at schedule time (authority is checked and the digest is bound then) and stores `scheduled`. An in-process ticker (every 30 s; Marketplace runs one replica) claims due rows with a guarded `UPDATE … WHERE status = 'scheduled'`, then repeats 3a, 3b, 3d at send time and confirms that the grant or approval is still valid. If anything fails: `skipped` with the reason, never a silent retry. A post more than 15 minutes late (downtime) becomes `expired`. Owner approval of a scheduled per-payload post expires at `sendAt`.

**One approval experience (Coordinator condition, 2026-10-09).** The owner approves a channel post in the same places as every other outward action: TBD and a signed Buzz reply. There is never a second prompt for the same post, and there is never a path where neither layer asks (except an owner-approved standing grant, which is itself an owner approval with an expiry and a receipt per send).

1. **K1, contract alpha.6 + kit rc.15.** Operations declare `approvalAuthority: "harness" | "app"` (default `harness`) and the defined response shape (`202 approval_pending {approvalId, digest, expiresAt, payloadView}` or `200` + receipt). The manifest alone never switches off the harness prompt: the kit honours `"app"` only when the operation is `external-effects` **and** the Portal-signed grant marks that registration as app-approval-trusted (a flag only Portal or the owner sets). Otherwise the harness prompts as today (fail closed). `channels.post`, `channels.schedule` and `channels.test` declare `"app"`.
2. **Hold surfaces through the harness.** Marketplace answers `202 approval_pending` with `{approvalId, digest, payloadView}` (the canonical payload, file hashes, image previews by URL). The kit shows exactly this in TBD and DMs the owner on Buzz with the 12-hex digest prefix, the same as its own gate (16,000-char view limit; larger payloads are refused, never clipped).
3. **Owner decision reaches Marketplace signed (two proof types, one decision).** The kit forwards the proof unchanged with the `approvalId` to `marketplace.approvals.resolve` (agent audience, binds only to the caller's own held call). The kit never mints a proof and the model never sees one.
   - **Buzz:** `{proof: "nostr", event: <full owner-signed event>}` from the owner's reply `approve <12+ hex>`. Marketplace verifies locally with the kit's `verifyOwnerApproval` (K2) over an in-memory `OwnerApprovalRelay`: recomputed NIP-01 id, BIP-340 signature, owner pubkey pinned from the Portal claim, `h` tag, digest prefix, age ≤ 15 min, single use. No relay read, no buzz CLI on the server.
   - **TBD:** `{proof: "portal", token: <Portal-signed owner approval assertion>}`. The owner's key never leaves the owner's Mac, so TBD cannot sign a Nostr event. When the owner presses Approve or Deny, the TBD client asks Portal for a short-lived EdDSA JWT (PO3). Mint auth: only the deployment owner's interactive Portal session, never an agent or runtime credential; Core checks ownership and readiness, strict formats, a per-user rate limit, and audits each mint (approvalId, digest prefix, decision; no content). Token: header `typ: "tealbrick-owner-approval+jwt"`, claims `typ: "tealbrick-owner-approval"`, `iss` = Portal issuer, `sub` = `tealbrick-user:<owner userId>`, `aud` = `tealbrick-app:<claimed instanceId>` (L2 id space), `dep` = deploymentId, `approvalId`, `digest`, `decision: "approve" | "deny"`, `jti`, `iat`, `exp` ≤ 300 s; signed with the org grant JWKS key. Marketplace verifies signature, `iss`, `aud`, `typ`, `exp`, `sub` = owner from its claim binding, digest = held call, `jti` single use (kept until `exp`). **Type separation:** Marketplace rejects every other `typ`, including L2 grant JWTs, and the L2 verifier rejects this `typ` (kit, both sides).
   - Interim if PO3 is late: TBD shows the hold and tells the owner to approve in Buzz (fail closed, still one decision).
   - The Marketplace Approvals view (owner session) stays as a third surface on the same queue. The harness records `owner.approval` (channel `app`) and the final `outward.receipt`, and tells the model not to retry while pending.
4. **Conformance** (kit conformance suite + Marketplace contract tests): (a) `approvalAuthority: "app"` on a `read-only` or `writes-app-state` op is rejected, and an `"app"` op without the Portal trust flag still gets the harness prompt; (b) an app-authority op called with no grant and no approval returns `202 approval_pending` and performs no provider call (provider-call counter = 0); (c) the harness surfaces that hold in TBD and Buzz; (d) for both proof types, an unsigned, foreign-owner, wrong-audience, stale, reused or digest-mismatched proof is refused; (e) after a valid resolve, exactly one provider call runs with the approved digest.

Until K1 and K2 ship, Marketplace runs under harness authority (the kit prompts) and does not ship app-authority holds to prod; P1 release waits for K1/K2 (§13).

## 7. Receipts and audit

Receipt (returned to the agent, kept in `channel_receipt`), compatible with the kit `ToolReceipt`:

```json
{"resultIds": ["<provider message id>"], "resultUrls": ["https://t.me/c/…/123"], "status": "sent",
 "detail": "telegram chat <title>", "channelId": "…", "postId": "…", "digest": "<64 hex>",
 "authority": "grant:<id>", "approvedAt": "…", "sentAt": "…", "provider": "telegram"}
```

`status`: `sent | failed | uncertain | pending | skipped | cancelled | expired`. A scheduled post returns `pending` with its `postId`; a later `receipts.list` shows the final state (the kit treats `pending` as non-terminal and records `receipt.update`).

- `channel_receipt` is a **domain record** with the text, retention 90 days by default (owner setting), purgeable. It is not called an audit trail.
- `audit_event` holds actor, operation, channel id, post id, outcome, time and the payload SHA-256 only (contract §12.8).
- Usage ledger: shapes only (existing `usage-ledger.ts`).

## 8. Credentials (contract §12.4, §12.4.1)

| Provider | Credential | Hosted (Railway) | Self-hosted |
|---|---|---|---|
| Telegram | bot token | Account Connections writes the Railway shared variable `MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN` (settings field `source: "account"`, `destination: "provider-env"`) | `app-api` settings PUT → encrypted `connector_secret` |
| Discord | bot token, application id | `MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN`, `…_APPLICATION_ID` | same |
| Slack (P2) | bot token `xoxb-` | `MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN` | same |
| Listmonk (P2) | base URL, API user, token | `MARKETPLACE_CHANNELS_LISTMONK_{URL,USER,TOKEN}` | same |
| Email (P2) | SMTP host/user/password or Resend key | `MARKETPLACE_CHANNELS_SMTP_*` / `…_RESEND_API_KEY` | same |
| Gmail (later) | OAuth | Clerk token at use time (§12.4.1, `gmail.send`) | — |
| X, LinkedIn Page, Facebook Page, Instagram (P3) | OAuth | existing Composio connected account | same |

Rules: Portal and Marketplace never persist hosted credentials (Marketplace reads the env at start; rotation = edit the shared variable, redeploy). Readiness verifies each credential (`getMe`, `GET /users/@me`, `auth.test`) and reports `credential_missing|credential_invalid` without echoing it. Hygiene tests assert the token never appears in DB rows, responses, receipts, logs, audit or error reports. LinkedIn Page posting needs restricted scopes, so it stays on Composio until §12.4.1 allows it.

## 9. Rate caps (three layers)

1. **Provider limits** (adapter): Telegram ≈ 1 msg/s per chat and 20/min per group; Discord per-route buckets. A per-destination token bucket in the adapter plus `retry_after` handling.
2. **Channel ceiling** (owner, shared by all agents): default 6/day, 600 s apart, one per phase.
3. **Standing grant** (per agent, ≤ ceiling).

Refusals: `429 channel_cap_per_day | channel_cap_per_hour | channel_min_interval (retryAfterSeconds) | channel_phase_duplicate`. Owner-approved per-payload posts also count toward the channel ceiling; the owner can raise the ceiling, but an approval does not bypass it.

## 10. MVP: Telegram + Discord (Phase 1, Marketplace 0.2.0)

- **Telegram:** Bot API over HTTPS (thin TS client on `fetch`; `@chat-adapter/telegram` only if it stays dependency-light). `sendMessage`, `sendPhoto`, `sendDocument` (multipart), `getMe`. Discovery: owner adds the bot, writes one message, Marketplace reads `getUpdates` (`message`, `channel_post`, `my_chat_member`) once per discovery; chat titles are untrusted text. Forum topics via `message_thread_id`. Receipt URL `https://t.me/<username>/<id>` for public, `https://t.me/c/<id>/<msg>` for private supergroups.
- **Discord:** REST v10 with `discord-api-types`. `POST /channels/{id}/messages` with `allowed_mentions: {parse: []}` always; attachments via multipart `files[n]`. Discovery: `GET /users/@me/guilds` + `GET /guilds/{id}/channels` (text and announcement). Bot permissions: View Channels, Send Messages, Attach Files, Embed Links; Create Events only for P2. No privileged intents. No gateway in P1.
- Owner UI (Channels tab): provider readiness, discover, create and edit channel and ceiling, grant to agent (→ Portal consent), standing-grant inbox (approve, narrow, decline, revoke), per-payload approvals (existing queue, with full text, image preview and file hashes), scheduled posts, receipts.
- Scheduled posting under standing grants (§6).

Acceptance (dev, real test chat and test channel):
1. An agent with consent and an active standing grant posts to the Telegram channel and gets a `sent` receipt with a working URL.
2. The 7th post that day is refused (`channel_cap_per_day`), a post 5 minutes after the last is refused (`channel_min_interval`), a second `announce` for the same campaign ref is refused, and a post to a channel without consent returns 404.
3. On a channel without a grant, the post returns `202 approval_pending`; the owner approves in Marketplace; the retry with the same idempotency key posts exactly the approved digest. A changed text needs a new approval.
4. A grant proposal wider than the ceiling is refused; the owner narrows a proposal and approves; the agent's widening `narrow` is refused.
5. A scheduled post under a grant is sent on time; a grant revoked before `sendAt` gives a `skipped` receipt.
6. Discord: `@everyone` in the text pings nobody; a photo posts with the text; a 429 is retried once.
7. Revoking the Portal consent suspends the grant and refuses the next post.
8. Hygiene: the bot tokens appear nowhere in DB rows, responses, receipts, logs, audit.
9. Upgrade rehearsal 0.1.19 → 0.2.0 in place, then rollback to 0.1.19 on the same data directory starts and ignores the new tables.

## 11. Henry migration

1. Martin adds the Telegram and Discord bot tokens through Account Connections (credentials are Martin's).
2. The owner creates Henry's channels with Henry's current caps as the ceiling (6/day, 600 s, one per phase, confirmed event with the current listing hosts).
3. Henry proposes standing grants (promo announce/reminder/recap); Martin approves.
4. Cut over: Henry's `bots_post` is turned off when its channel is live (never both, to avoid double posts). `henry_mail` moves to an email channel in P2. `henry_desktop` stays: no-API platforms are not Channels.

## 12. Non-goals

- Platforms without an API (Facebook groups, OpenChat, event sites): they use Codex computer use with per-post approval, outside Channels. (Draft v0.1 had a `bridge` executor; it is removed.)
- Unofficial clients (Baileys, userbots, self-bots) and fake person accounts.
- Bulk or unsolicited messaging, scraping member lists, cold email.
- A general social-media scheduler UI. Channels is the governed agent path.

## 13. Cross-lane requests

| Id | Owner | Request | Needed by |
|---|---|---|---|
| K1 | Lead · Packages (contract alpha.6 + kit rc.15) | `approvalAuthority` + response shape; honoured only with the Portal trust flag on `external-effects` ops; harness surfaces the app's hold in TBD and Buzz, forwards the owner-signed event, records receipts; conformance (a)–(e) in §6 | P1 release |
| K2 | Lead · Packages (kit rc.14) | `@tealbrick/kit/owner-approval`: `verifyOwnerApproval`, `nostrSignatureValid`, `nostrEventId`, `MIN_DIGEST_PREFIX`, types (server-safe; no relay reader needed, §6.3) | P1 release |
| PO2 | Lead · Portal | App-approval-trusted flag per registration in the signed grant (set by Portal or owner only), for K1 | P1 release |
| PO3 | Lead · Portal (mint, ≈1 d); TBD client owner to be assigned by Coordinator | Owner-only mint endpoint for the `proof: "portal"` assertion with `typ` separation (§6.3); TBD client requests it on Approve/Deny | P1 release (interim: Buzz only) |
| PO1 | Lead · Portal | Done 2026-10-09: shape accepted unchanged. Marketplace grant-review adds display-only `actionGroupLabel` (plain text ≤ 80, never stored or used for authority); Portal renders it, falls back to the slug. 0.2.0 must keep the 0.1.18 template topology (no new services or volumes) | P1 |
| MI1 | Lead · Miniapps | Review the executor seam refactor of `executeConsentedCall` (no behaviour change) before Channels code lands | P1 first PR |

## 14. Coordination constraints (Lead · Miniapps, 2026-10-09)

1. Releases are serial and cut by Lead · Miniapps. Channels ships as Marketplace 0.2.0 after 0.1.19; app `major` stays 1.
2. 0.1.19 is in flight (`Catalog.tsx`, `provider-health.ts`, cards API `connectMode`). Channels branches start from main after 0.1.19 merges.
3. New tables are additive (`CREATE TABLE IF NOT EXISTS`, no data rewrite), with an in-place upgrade and a rollback rehearsal on one data directory.
4. One execution path (C1).
5. Lead · Miniapps is a required reviewer on every Channels PR that changes `program/`, `web/`, migrations, `tealbrick.app.json`, `release/`, `.woodpecker/` or recipes.
6. All new code, tests and tooling are TypeScript.

## 15. Resolved questions from v0.1

1. **Credentials:** native for messaging, newsletters and email (Railway shared variable, or `connector_secret` self-hosted); Composio for heavy-OAuth social apps (§8).
2. **Persistent worker:** in-process inside Marketplace (single replica) for the scheduler (P1) and for Telegram webhook and Discord gateway (P4). A separate service only if Marketplace ever runs more than one replica.
3. **Bridge device registration:** removed with the bridge executor (§12).
4. **Policy source of truth:** the Marketplace DB (§4.4). The kit file stays harness-local.
