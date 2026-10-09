# Marketplace Channels build plan

Status: proposed, 2026-10-09, waiting for Coordinator · Teal Brick. Spec: [channels-spec.md](channels-spec.md) v0.2.
Estimates are worker-days (wd) of focused implementation including tests. Calendar time assumes two parallel workers after the seam PR, Lead · Channels integrating and reviewing, and Lead · Miniapps reviewing code PRs.

## Gate 0: before any code

- Coordinator confirms this plan.
- 0.1.19 merged to main (Lead · Miniapps, ETA ~1 day). Channels branches start from that main.
- PO1 answered by Lead · Portal (consent dialog shows `channel:<slug>`; 0.1 → 0.2 upgrade path accepted).
- Coordinator accepted 2026-10-09 with conditions (one approval experience, standing-grant rules, TypeScript only, bot tokens via Account Connections by Martin, Henry cutover is Martin's go).
- K1 (contract alpha.6 + kit rc.15, Portal trust flag PO2) and K2 (kit rc.14) agreed with Lead · Packages; they gate the P1 **release**, not P1 code.

## Phase 1: Marketplace 0.2.0, Channels core + Telegram + Discord (MVP)

| # | Work package | Est. | Depends | Files (main areas) |
|---|---|---|---|---|
| 1a | Executor seam: extract an `ExecutionTarget` interface from the if/else chain in `executeConsentedCall`; Composio, custom MCP and OpenAPI become targets. No behaviour change, existing tests unchanged | 1 | Gate 0 | `program/src/app.ts`, new `program/src/execution-targets.ts` |
| 1b | Schema and store: `channel`, `channel_standing_grant`, `channel_post`, `channel_attachment`, `channel_receipt` (additive), table inventory, hygiene | 1.5 | Gate 0 | `program/src/store.ts`, new `program/src/channels/store.ts` |
| 1c | Provider adapters Telegram + Discord: send text, photo, document; discover; verify credential; capability declaration; token bucket; 429 handling; receipt URLs | 2 | 1b | new `program/src/channels/providers/{telegram,discord}.ts` |
| 1c-2 | Native media: capability declaration per §3.1 (static + live), Telegram `sendAudio`/`sendVideo`/`sendVoice`, Discord audio/video files and the voice → audio + transcript fallback, `kind` in attachments and digest | 1 | 1c | `channels/providers/*` |
| 1d | Policy engine: ceiling, content rules, confirmed-event live check, digest, transactional caps and reservation, error codes | 1.5 | 1b | new `program/src/channels/policy.ts` |
| 1e | Authority: hold through the generalised approval queue, approved-digest consumption, attachments upload | 1.5 | 1a, 1d | `app.ts` (hold site), `channels/routes.ts` |
| 1f | Standing grants: propose, approve, narrow, decline, withdraw, revoke, automatic suspension on consent or ceiling change | 1.5 | 1d | new `program/src/channels/grants.ts` |
| 1g | Scheduler: schedule, cancel, in-process ticker, send-time re-check, `skipped`/`expired` | 1 | 1e, 1f | new `program/src/channels/scheduler.ts` |
| 1h | Owner UI: Channels tab (readiness, discover, create and edit, grant to agent → Portal consent, grant inbox, approvals with preview, scheduled, receipts) | 2.5 | 1c–1g APIs | new `program/web/src/channels/*.tsx` |
| 1i | Manifest ops and settings fields, `docs/contract.md`, contract tests (owner-only loop, cross-agent 404, idempotency), conformance | 1 | 1c–1g | `tealbrick.app.json`, `program/src/*.test.ts` |
| 1k | One approval experience: `202 approval_pending` shape with `payloadView`, `actionGroupLabel` in grant-review, `marketplace.approvals.resolve` verifying the forwarded owner-signed event with kit `owner-approval` (K2), `approvalAuthority` declarations (K1), conformance (a)–(e) | 1.5 | 1e, kit rc.14 / rc.15 | `channels/approvals.ts`, `tealbrick.app.json` |
| 1j | Dev proof: real test Telegram chat and Discord channel, all §10 acceptance items; upgrade 0.1.19 → 0.2.0 and rollback rehearsal on one data directory | 1 | all | evidence in `/Users/puma/work/artifacts/marketplace-channels-0.2.0/` |
| | **Phase 1 total** | **17 wd** | | ≈ 8–10 calendar days; release also waits for kit rc.15 + contract alpha.6 (K1) and Portal PO2 |

PR sequence (each reviewed by Lead · Miniapps): (1) 1a seam; (2) 1b + 1d store and policy; (3) 1c providers; (4) 1e + 1f + 1g authority, grants, scheduler; (5) 1h UI; (6) 1i manifest and docs. Lead · Miniapps cuts 0.2.0 after 1j evidence. Prod rollout: evidence to Coordinator, Coordinator approves.

Henry cutover (0.5 wd, after 0.2.0 is in prod): needs Martin to add the bot tokens through Account Connections (credentials are Martin's) and to approve Henry's first standing grants. Coordinated with Lead · Henry.

## Review conditions from Lead · Miniapps (2026-10-09)

1. 1a seam: identical ledger rows, audit events, idempotency keys and error codes; existing tests unchanged plus a snapshot (response, ledger row, runtime audit rows) per target, recorded on the old code first.
2. 1g scheduler: row claims with `claimed_by` + lease expiry, even though a volume-backed Railway service runs one replica; redeploy overlap or a crash mid-send must not double-send; test a claim taken over after lease expiry.
3. 1j rehearsal: 0.1.19 → 0.2.0 (create a channel and a scheduled post) → 0.1.19 → 0.2.0. Release notes say scheduled posts do not fire while on 0.1.19 and become `expired` after the return.
4. Secrets: hosted tokens only via Account Connections (provider env, never persisted); self-hosted in `connector_secret` with the existing key; responses show keyed fingerprints only. Portal's `MARKETPLACE_ACCOUNT_KEYS` and pinned settings provenance change at cut time (Lead · Portal informed early).
5. Every real send, including the 1j proof, goes only to Martin-owned test chats.
6. New ops in `tealbrick.app.json` with effects and idempotency; Woodpecker conformance stays green.

## Phase 2: Marketplace 0.2.x, more providers and native features (7.5–9.5 wd)

- Email channel (SMTP or Resend; recipient allowlist; strangers become drafts) and Henry `henry_mail` cutover: 2 wd.
- Listmonk newsletter channel (campaign create, test send to owner, send; list as destination): 1.5 wd.
- Slack channel (`chat.postMessage`, files, `chat.scheduleMessage` as `schedule.native`): 1 wd.
- Buzz approval of standing-grant proposals (posts are already covered in P1): 0.5 wd.
- Discord scheduled events (`events.create`): 1 wd.
- Native features P2: Discord native voice messages, Telegram `markdown-v2`, reply-to, URL buttons, polls, reactions, edits/deletes, audience count: 2–3 wd.

## Phase 3: social and community (4–5 wd)

X, LinkedIn Page, Facebook Page, Instagram through existing Composio connections as `composio` targets with the same policy and receipts (3 wd); Discourse category (1–2 wd).

## Phase 4: inbound (5–7 wd, needs an agent-wake contract decision)

Telegram webhook (secret token header), Slack Events API, Discord gateway worker (in-process), dedup, `marketplace.channels.read`, routing an inbound message to one agent. The route to wake an agent is an open cross-lane item (Portal / Packages).

## Risks

| Risk | Mitigation |
|---|---|
| `app.ts` is 8.7k lines and owned by Miniapps; merge conflicts with their sprints | Seam PR first; Channels code in `program/src/channels/`; small, early PRs |
| First background worker in Marketplace | Single replica (recipe pins 1), guarded claims, restart-safe rows, `expired` after 15 min |
| Double approval prompt (kit harness + Marketplace) | K1 with Portal trust flag; no app-authority hold ships to prod before K1 |
| Portal refuses upgrade if template topology changes | No new services or volumes (scheduler in-process, attachments on `/data`); send the 0.2.0 template diff to Lead · Portal early |
| Shared-variable credentials need a redeploy to rotate | Documented; readiness shows `credential_invalid` at once |
| Telegram discovery depends on recent updates | Owner writes a message just before discovery; manual chat id entry is not allowed for agents, only for the owner with a verification send |
| Provider terms (automation labels, X cost) | Automated-account labels in setup steps; X in P3 with a cost note |

## Proof boundary

Phase 1 is done when every §10 acceptance item has evidence on dev with real Telegram and Discord destinations, the rehearsal passes, and Lead · Miniapps has reviewed every code PR. Prod use starts only after Coordinator approval; any real outward post to a public destination needs Martin's approval (outward posts are Martin's).
