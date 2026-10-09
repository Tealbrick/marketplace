# Marketplace Channels (spec, draft v0.1)

Status: draft, 2026-10-09. Owner: Lead · Channels (new lane inside the Marketplace miniapp). It builds on the existing connection, consent and `marketplace.tools.call` path ([contract.md](contract.md)) and on the kit outward-action gate (kit 0.3.0-rc.13).

## 1. Problem

Marketplace governs **connectors** (toolkit, actions, connection, consent). For messaging and publishing, that is not enough:
- The **destination** (a Telegram chat, a Discord channel, a LINE Official Account, a Slack channel, a Facebook Page) is only an argument that the agent passes. Nothing records which destinations an organization owns, which agent may use which one, its posting rules, its rate, its audience, or its receipts.
- Limits and approval rules for posting end up inside each agent's private tools, so other agents and customers cannot reuse them, and the organization cannot see them.
- Composio covers sending for many apps. But every message and token then goes through a third party, and Composio has no destination or policy layer, and no inbound for several channels.

## 2. Concept

A **Channel** is one connection, plus one destination, plus a policy. Agents are granted Channels, not toolkits.

```
Connection (credential, provider)  1──n  Channel (destination + policy)  n──n  Agent grant (Portal)
                                                    │
                                     Receipts · Inbound events · Audit
```

### Channel record

| Field | Meaning |
|---|---|
| `id`, `organizationId`, `label` | Stable id; human label ("Community Telegram") |
| `provider` | `telegram`, `discord`, `slack`, `line`, `whatsapp_cloud`, `facebook_page`, `instagram`, `linkedin_page`, `x`, `browser:<site>` |
| `executor` | `native` (Marketplace adapter), `composio` (toolkit), or `bridge` (Local Runtime Bridge browser job on a device) |
| `connectionId` | The existing Marketplace connection that holds the credential |
| `destination` | `{kind: chat\|channel\|group\|page\|account\|broadcast, externalId, url?, title}`; discovered from the provider, never typed by an agent |
| `audience`, `language` | For agents and for the organization's view |
| `policy.effects` | Always `outward` for post/broadcast/schedule |
| `policy.approval` | `standing` (standing grant: caps apply, no per-post approval) or `per_payload` (every post waits for owner approval of the exact payload) |
| `policy.caps` | `perDay`, `minIntervalSeconds`, `onePerPhase` (one post per destination per event phase) |
| `policy.requireConfirmedEvent` | The post must reference a live public listing (allowlisted listing hosts) |
| `policy.contentRules` | Optional: max length, required link, forbidden mentions (`@everyone`), language |
| `inbound` | `{enabled, mode: webhook\|poll\|gateway, routeTo: agentId?}` |
| `status` | `draft`, `active`, `paused`, `revoked` |

### Agent operations (new, `tealbrick.miniapp/v1`)

| Operation | Effects | Purpose |
|---|---|---|
| `marketplace.channels.list` | read-only | The calling agent's granted channels, with policy and caps used today |
| `marketplace.channels.post` | outward | `{channelId, text, files?, eventUrl?, phase?}` → receipt. `Idempotency-Key` required |
| `marketplace.channels.schedule` | outward | Schedule a post or a provider event (Discord scheduled event, Slack scheduled message) |
| `marketplace.channels.read` | read-only | Recent messages in a channel the agent may read |
| `marketplace.channels.receipts` | read-only | The agent's own receipts |

Owner operations: `channels.create`, `channels.update`, `channels.pause`, `channels.discover` (lists destinations a connection can reach, e.g. Slack `conversations.list`, Discord guild channels, Telegram chats seen in updates), `channels.grant` (through the Portal consent flow).

### Governance

1. **Portal** grants a Channel to an agent (canvas edge → consent). There is no channel access without a grant.
2. **Kit outward gate:** `channels.post` and `channels.schedule` are declared `outward`. A `per_payload` channel waits for the owner's approval of the exact payload in TBD, or through the owner's Buzz reply `approve <12+ hex digest prefix>` (`verifyOwnerApproval`). A `standing` channel runs under the standing grant, and Marketplace enforces the caps server-side.
3. **Marketplace** enforces the policy (caps, pace, one-per-phase, confirmed event, content rules), idempotency, the audit trail and receipts. This is the same path as `tools.call` (rules/owner approval, usage ledger).
4. **Credentials** stay in Marketplace (or in Composio for `composio` channels). They never reach agents, prompts or logs.
5. Receipts follow the gate shape `{resultIds, resultUrls, status: sent|failed|pending, detail}`. `pending` is used for asynchronous executors (bridge jobs), and is updated later on the same digest.

## 3. Executors and providers

| Provider | Executor | Library or route | Inbound | Notes |
|---|---|---|---|---|
| Telegram | native | `@chat-adapter/telegram` (Vercel Chat SDK, MIT; raw Bot API, no extra deps) | webhook or poll | Bot as admin of the chat/channel; photos and documents |
| Discord | native | thin REST on `discord-api-types`; scheduled events from OpenClaw `extensions/discord/src/send.guild.ts` (MIT, keep the notice) | gateway (phase 3, persistent worker) | Bot role limited to send and Create Events; never `@everyone` |
| Slack | native | `@chat-adapter/slack` or `@slack/web-api` | Events API over HTTP | `conversations.list` for discovery |
| LINE OA | native | `@line/bot-sdk` (Apache-2.0): push, reply, **broadcast**, narrowcast | webhook with signature check | Count quota per recipient; show the month's quota in the channel |
| WhatsApp | native | official Cloud API (`@chat-adapter/whatsapp`) | webhook (`X-Hub-Signature-256`) | Opt-in and template rules. **Never Baileys** (unofficial client, breaks WhatsApp terms) |
| Facebook Page, Instagram | composio | `facebook`, `instagram` toolkits (system-user token) | — | Page/IG only; groups have no API |
| LinkedIn Page | composio | `linkedin` toolkit (Page admin OAuth) | — | Never automated personal posting |
| X | composio | `twitter` toolkit | — | Pay-per-use cost; label as automated |
| Sites with no API (Facebook groups, event platforms) | bridge | Local Runtime Bridge "browser job" (computer use on the owner's device) with hard stops in code | — | Always `per_payload`; real accounts only |

Vercel Chat SDK (`github.com/vercel/chat`, MIT, TypeScript, Node ≥ 20) gives one adapter interface (post, edit, read, list, `handleWebhook`) that matches this spec. OpenClaw and Hermes Agent channel code is MIT but tightly coupled to their runtimes, so use it as **reference only**, except small leaf files.

## 4. Setup flow (owner)

1. **Connect:** add the credential (bot token, OAuth, Composio connection) in Marketplace.
2. **Discover:** Marketplace lists the destinations this connection can reach. The owner picks one. For Telegram, the owner writes one message in the chat so the bot sees it.
3. **Create the Channel:** label, audience, policy (standing or per-payload, caps, rules).
4. **Grant:** on the Portal canvas, draw the edge from the agent to the Channel, then consent.
5. **Verify:** Marketplace sends a test message only after the owner's approval, and shows the receipt.

## 5. Phases and acceptance

| Phase | Scope | Acceptance |
|---|---|---|
| 1 | Channel model, owner UI, `channels.list/post/receipts`; Telegram + Discord (send + files) + LINE (push + broadcast); policy enforcement; kit gate integration | An owner agent posts to a granted Telegram channel under a standing grant, gets a receipt, and is refused on the 7th post of the day, on a too-fast post and on an ungranted channel. A per-payload channel waits for owner approval and posts only the approved digest. |
| 2 | Slack, WhatsApp Cloud; inbound webhooks with dedup; `channels.read` | An inbound message reaches the routed agent once, with the source channel. |
| 3 | Composio-backed Page/IG/LinkedIn/X; Discord gateway worker; scheduled events | The same receipts and policies across executors. |
| 4 | Bridge executor (Local Runtime Bridge browser jobs) | A no-API destination post runs on the device only after per-payload approval, with a receipt URL. |

## 6. Non-goals

- Unofficial clients (Baileys, userbots, self-bots) and fake persona accounts.
- Bulk or unsolicited messaging, scraping member lists.
- A general social-media scheduler UI (Postiz-like). Channels is the governed agent path.

## 7. Open questions

1. Credential storage: Marketplace secret store for native channels versus Composio for all channels. The proposal is native for messaging, Composio for heavy-OAuth apps.
2. A persistent worker for the Discord gateway and Telegram polling: a sidecar or a separate service?
3. Where the bridge executor's device registration lives (Local Runtime Bridge pairing versus Portal).
4. A per-channel approval policy versus the kit standing-grant file: a single source of truth is needed.
