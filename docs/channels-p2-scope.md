# Channels Phase 2: scope for Martin

Status: proposal, 2026-10-10. Author: Lead · Channels. Decision: Martin.
This document is in ASD-STE100 Simplified Technical English. It is a scope only. There is no code before Martin selects the scope.
It replaces the earlier short options note (`channels-p2-options.md`) where they differ.

Martin's priorities (2026-10-10):
1. Buzz with all its features from the first day. Buzz is the primary platform between humans and agents.
2. Then Slack, Microsoft Teams, Telegram, iMessage (if it is possible), Discord.
3. Later: WhatsApp, LINE and other channels.

Effort is in worker-days (wd). One worker-day is one day of focused work, tests included. Estimates have a range, because some facts are not verified (see §11).

## 1. Summary and recommended plan

| Phase | Scope | Effort | Calendar (2 workers) |
|---|---|---|---|
| **P2** (Martin, 2026-10-10: one phase) | Shared changes (capability model v2, inbound worker, live-session grant with consent). **Buzz: all features** (channels, DMs, threads, mentions, files, reactions, edits, deletes, canvas, inbound, **huddles**). **Slack.** Telegram and Discord additions (reactions, edits, replies, Discord native voice messages, **Discord voice channels**). | 46–65 wd (less if the new kit covers Buzz huddles or voice, §13) | 5–7 weeks |
| **P3** | Microsoft Teams (messages, cards, files). iMessage only if Martin accepts the business route (§8). WhatsApp Cloud API, LINE. | 20–35 wd | after P2 |
| Not recommended | Teams live meetings (Windows/.NET media bots). iMessage through a Mac bridge inside Channels. Telegram voice chats (bots cannot join). | — | — |

Why Teams is in P3 and not P2: each customer must do Microsoft 365 admin work (app upload, consent, install in each team). Do Teams in P2 only if a customer needs it now.

## 2. Shared changes (all channels)

### 2.1 Capability model v2

The Phase 1 model (spec §3.1) declares what each adapter supports. Phase 2 adds these keys. New keys need a contract minor version.

| Key | Values | Use |
|---|---|---|
| `dm` | `{open: bool, maxMembers}` | Direct messages (Buzz DMs, Slack DMs, Teams 1:1) |
| `thread` | `{replies, topics, forum}` | Replies and forum posts |
| `mentions` | `{users: bool, broadcast: "suppressed"}` | Mention named users. Broadcast mentions never ping. |
| `reactions` | `{add, remove, custom}` | Reactions |
| `edit`, `delete` | `{own: bool, window?}` | Edit or delete the agent's own message |
| `canvas` | bool | Shared document per channel (Buzz) |
| `presence` | `{typing, status}` | Typing and status signals |
| `ephemeral` | bool | Messages that only one user sees, or that expire |
| `live` | `{join, listen, speak, transcript, maxMinutes}` | Huddles, voice channels |
| `inbound` | `{mode: socket|webhook|poll, dedupe}` | Receive messages for agents |

The rules from Phase 1 do not change: agents and the owner screen get only declared features. An undeclared feature is refused (`channel_capability_unavailable`), or a declared fallback is applied before the approval digest.

### 2.2 Inbound worker (needed for Buzz, Slack, Telegram, Discord)

Phase 1 sends only. Phase 2 also receives messages for agents.
1. One in-process worker in Marketplace holds the long-lived connections: the Buzz relay socket, the Discord gateway, the Telegram webhook, the Slack Events API.
2. It removes duplicates by event id. It ignores the agent's own messages.
3. It has a loop breaker: maximum 4 agent turns per thread in 15 minutes, maximum 8 per peer, and a rate limit per sender. The Buzz kit already uses these numbers.
4. It sends each message to the agent that the owner routed for that channel. The route to wake an agent is a cross-lane item (Portal / Packages).
5. All received text is untrusted data, never instructions.
6. A bot token or key serves one consumer. Marketplace takes a consumer lease per credential (Phase 1 spec §8).

Effort: 5–7 wd.

### 2.3 Live-session grant (huddles and voice)

The owner cannot approve each spoken sentence before it is said. Live voice therefore needs a new grant type. The rules:
1. **Who approves.** Only the owner. The agent may propose a live-session grant. The owner may approve it as proposed or narrow it. Nobody can widen it.
2. **Limits.** One channel or huddle, one agent, a start and end time (maximum 2 hours per session, maximum 30 days for the grant), maximum minutes per day, a topic, and a list of words and subjects that are not permitted.
3. **Modes.** `listen` (speech-to-text only), `speak-approved` (play audio clips that the owner approved by digest), `speak-live` (text-to-speech from the agent's live text). Each mode is a separate permission.
4. **Disclosure and consent.**
   - When the agent joins, it posts a notice in the channel: "An AI agent is in this huddle. It listens and writes a transcript."
   - In `listen` mode, every human participant must accept once per session before Marketplace stores their speech. A person who does not accept is not transcribed.
   - Marketplace never stores raw audio. It keeps only the transcript, with a retention period.
5. **Receipts.** The receipt is the full transcript of what the agent said and heard, with times, plus the join and leave times. The audit log keeps metadata and a SHA-256 only.
6. **Stop.** The owner can end a session at any time. Pause or revoke takes effect at once. The agent leaves within 5 seconds.
7. **Costs.** Speech-to-text and text-to-speech providers cost money per minute. The grant has a cost cap.

Effort: 4–6 wd (policy, owner screen, receipts). The audio work for each channel is separate.

### 2.4 Approvals stay in one place

Owner approvals stay in TBD, Buzz and the Marketplace screen (the Phase 1 "one approval experience"). Other channels (Slack, Teams, Telegram, Discord) show "waiting for owner approval" and never accept an approval click. Reason: an approval must be an owner-signed proof (Nostr signature or Portal assertion). A click in Slack or Teams is not owner-signed.

## 3. Buzz (priority 1)

Facts are from the Buzz source (`block/buzz`, desktop 0.5.25), the `buzz` CLI and the Tealbrick kit.

| Capability | Buzz support | Channels plan | Phase |
|---|---|---|---|
| Text in channels | Yes (NIP-29, kind 9). Limit 65,536 characters. | Post, schedule, standing grants (as Phase 1) | P2 |
| Channel types | Stream; forum (preview); ephemeral channels with idle time-out | Stream and forum post; ephemeral channels as a destination type | P2 |
| DMs | Yes (Buzz DMs, 1–8 people) | Agent DMs to named people, owner-approved | P2 |
| Threads and replies | Yes (NIP-10 reply tag) | `replyTo` in the post body | P2 |
| Mentions | Yes (`p` tags). An agent wakes only on a `p` tag for it. | Mention named users; broadcast mentions suppressed | P2 |
| Files and images | Yes (Blossom upload). Images and MP4 today. PDF, Markdown and text need an upstream fix (Tealbrick branch exists; status not verified). | Images and video in P2a; PDF/text when the upstream fix is in the deployed relay | P2 |
| Voice notes | No. Buzz has no voice-note message. | Declared fallback: audio file (if the relay accepts it) plus transcript, or refuse | P2 |
| Reactions | Yes (kind 7, custom emoji) | Add and remove reactions | P2 |
| Edits and deletes | Yes (edit kind 40003, Buzz-only; delete kind 5, own messages) | Edit and delete own messages, owner-approved like a post | P2 |
| Canvas | Yes (one shared document per channel, with history) | Read and propose edits; an edit is outward and needs approval | P2 |
| Pins, bookmarks, scheduled messages, reminders | Protocol kinds exist. No CLI. | Not in P2. Marketplace schedules posts itself. | — |
| Polls | No | Refuse (`channel_capability_unavailable`) | — |
| Typing and presence | Yes (ephemeral events) | Typing signal while the agent writes | P2 |
| Read receipts | No (only the user's own read position) | — | — |
| Search and history | Yes (search, history up to 500 per request) | `channels.read` for agents with read consent | P2 |
| Inbound | Yes (relay socket subscriptions; HTTP query as polling) | Inbound worker (§2.2) | P2 |
| Huddles: listen | Huddle audio is Opus over a Buzz WebSocket (not WebRTC). Speech-to-text runs on the Desktop client today. No bot SDK. | A Marketplace huddle client: join with the agent key, receive Opus, speech-to-text, transcript receipt, under a live-session grant (§2.3) | P2 |
| Huddles: speak | The Desktop makes speech locally (Pocket TTS) and publishes it with the agent key. No server SDK. | `speak-approved` (approved clips) first, then `speak-live` (text-to-speech) | P2 |
| Huddle recording | Not built in Buzz | Marketplace keeps transcripts only, never audio | P2 |
| Screen share, video | No | — | — |
| Workflows and workflow approvals | Experimental; approval gate not wired end to end | Not used. Owner approvals use the Tealbrick flow. | — |
| Moderation | Yes (reports, ban, time-out) | Not for agents. Owner tools only. | — |
| Approvals in channel | Owner approvals through Buzz already work (kit; contract alpha.7) | Unchanged | done |
| Identity and auth | One Nostr key per agent identity. The owner signs a NIP-OA tag that limits what the key may publish. The relay must allow NIP-OA auth. | Marketplace holds one agent key per Buzz channel identity (encrypted, never shown). The owner signs its NIP-OA tag with limits (`kind=9`, end date). | P2 |
| Rate limits | Relay limits: agent 120 messages/min (default); configurable | Channel caps (Phase 1) under the relay limits | P2 |

**Martin's setup for Buzz:**
1. Confirm which Tealbrick relay is canonical (there are two Railway relays).
2. Confirm that the relay allows NIP-OA auth.
3. Sign the NIP-OA tag for the Marketplace agent key on your Mac (the key stays in Marketplace; your key stays on your Mac).
4. Decide if the relay must be updated, because the deployed relay image (7 September) is older than the source we read.

**Effort:** messages and inbound 6–8 wd (P2). Huddle client (listen, speak-approved, speak-live) 8–12 wd (P2), plus the shared live-session grant.

## 4. Slack (priority 2)

| Capability | Slack support | Channels plan |
|---|---|---|
| Text | `chat.postMessage`, `mrkdwn`, Block Kit | Post, schedule, standing grants |
| Threads | Yes (`thread_ts`) | `replyTo` |
| Files | Upload v2 (`files.getUploadURLExternal` + `files.completeUploadExternal`); old `files.upload` retired | Three-step upload; a failure after the share step is `uncertain` |
| Voice notes | No bot voice-clip API | Fallback: audio file + transcript |
| Live voice (huddles) | No official API for bots to join huddles | Not possible. Refuse. |
| Reactions | `reactions.add` (bot token) | Add and remove |
| Edits and deletes | `chat.update`, `chat.delete` (own messages) | Yes |
| Scheduling | `chat.scheduleMessage` (up to 120 days; 30 per 5 min per channel) | Native schedule (`schedule.native`) or the Marketplace scheduler |
| AI app features | Assistant threads, streamed replies, status | Optional later: agent replies inside Slack's assistant panel |
| Approvals in channel | Buttons exist, but a click is not owner-signed | Show "waiting"; approve in TBD, Buzz or Marketplace |
| Identity and auth | One Slack app per customer workspace; bot token `xoxb-` | Bot token in Account Connections (`MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN`) |
| Rate limits | About 1 message per second per channel. **History reads:** since 29 May 2025, new non-Marketplace commercial apps get 1 request per minute and 15 messages. Internal apps (built by the customer workspace) keep 50+ per minute. | Each customer creates an **internal** Slack app from our manifest (one click with a manifest link). No Slack Marketplace listing needed. |
| Martin's setup | Create the Slack app in your workspace from the manifest, install it, add the bot token | |

**Effort:** 3–4 wd (with inbound through the Events API).

## 5. Microsoft Teams (priority 2, recommended P3)

| Capability | Teams support | Channels plan |
|---|---|---|
| Text | Bot messages: Markdown/HTML subset, extended Markdown (tables, code); 100 KB limit | Post, schedule (Marketplace scheduler), standing grants |
| Cards and buttons | Adaptive Cards 1.5 | Link buttons; no approval buttons (§2.4) |
| Threads | Reply to a channel post | `replyTo` |
| Files | Channels: file references in the team's SharePoint. Upload consent cards work in 1:1 chat only. | Files in 1:1 chat; in channels only as SharePoint references (needs extra Graph permissions) |
| Voice notes | No bot API | Fallback: audio file + transcript (1:1 only) |
| Live meetings | Real-time media bots need C#/.NET on Windows servers in Azure. Microsoft does not recommend them for AI agents. | **Not recommended.** Use meeting transcripts later if needed. |
| Reactions | Bots receive reactions. Bot-added reactions are not confirmed. | Receive only |
| Edits and deletes | Bot can update or delete its own messages | Yes |
| Private channels | Bots cannot post there | Refuse |
| Receiving messages | Only when the bot is mentioned, unless the team grants RSC permissions | Inbound with RSC consent |
| Approvals in channel | No (§2.4) | Show "waiting" |
| Identity and auth | Azure Bot registration (single-tenant for new bots) + Entra app + Teams app package. The app must be installed in each team or chat before it can post. | Marketplace stores the conversation id at install. Credentials in Account Connections. |
| Rate limits | Per bot per thread: 7/s, 60 per 30 s, 1800/hour. 50 requests/s per tenant. | Provider limits in the adapter |
| Martin's or customer's setup | Azure subscription; Entra app; Teams admin: allow and upload the custom app; team owners consent to RSC; install in each team | |

**Effort:** 6–9 wd (messages, cards, install flow, inbound). Live meetings: excluded.

## 6. Telegram (Phase 1 additions)

| Capability | Telegram support | Phase 2 addition |
|---|---|---|
| Text, files, voice notes | Done in Phase 1 (`sendVoice` native) | — |
| Formatting | MarkdownV2, HTML | `markdown-v2` markup |
| Replies, topics | Reply parameters; forum topics | Reply-to (topics done) |
| Reactions | Bots can set reactions; manage reactions (Bot API 10.0) | Add and remove |
| Edits and deletes | Yes (own messages) | Yes |
| Rich messages, ephemeral messages, drafts | New in Bot API 9.5–10.3 (2026) | Declare later, after the facts are verified |
| Polls | `sendPoll` | Yes |
| Live voice (voice chats) | **Bots cannot join.** Only user accounts (unofficial clients) can, with ban risk. | Not possible. Refuse. |
| Inbound | Webhook (secret token) | Inbound worker |
| Approvals in channel | No (§2.4) | Show "waiting" |
| Identity and auth | One bot token (Phase 1) | Unchanged |
| Rate limits | About 1 message/s per chat, 20/min per group | Unchanged |
| Martin's setup | None beyond Phase 1 | |

**Effort:** 3–4 wd.

## 7. Discord (Phase 1 additions)

| Capability | Discord support | Phase 2 addition |
|---|---|---|
| Native voice messages | Flag `IS_VOICE_MESSAGE` (8192); OGG/Opus; waveform and duration required; no other content | Native voice message; transcript as a second message (two-step: `uncertain` on partial delivery) |
| Threads | Yes | Reply in threads |
| Reactions | Yes | Add and remove |
| Edits and deletes | Yes (own messages) | Yes |
| Scheduled events | Guild scheduled events (needs Create Events permission) | `events.create` |
| Polls | Yes | Yes |
| Live voice (voice channels) | Bots can join with DAVE end-to-end encryption (mandatory since 2 March 2026). Sending audio is documented. **Receiving audio is not documented by Discord** (libraries do it; no stability guarantee). Recording rules in the Developer Policy are not verified. | P2 on the live-session model: speak first; listen only after the policy check and with consent |
| Inbound | Gateway connection | Inbound worker |
| Approvals in channel | No (§2.4) | Show "waiting" |
| Identity and auth | One bot token (Phase 1) | Unchanged; voice needs Connect and Speak permissions |
| Rate limits | Per-route buckets | Unchanged |
| Martin's setup | Add the voice permissions to the bot if you want voice | |

**Effort:** messages 4–5 wd (P2). Voice channels 6–10 wd (P2), shared with the Buzz huddle audio work where possible.

## 8. iMessage (priority 2, decision needed)

There is no official iMessage API for bots. There are three routes:

| Route | What it can do | Risks | Effort | Recommendation |
|---|---|---|---|---|
| **A. Apple Messages for Business** | 1:1 only. The customer must start the chat (Maps, Safari, website button, QR code). After that, the business can send follow-ups. No groups. Rich types: quick replies, list pickers, Apple Pay. | Needs an Apple-approved Messaging Service Provider (MSP) and two Apple reviews. Approval time: days (Apple) to weeks (third-party reports). | 8–12 wd + MSP contract + Apple approval | Only for customer support use cases. It does not let an agent post to groups. |
| **B. Mac bridge** (BlueBubbles, AppleScript + Messages database) | Groups, attachments, tapbacks, edits (on a supported macOS version) | Needs an always-on Mac with a real Apple ID. Apple terms do not allow this kind of automation for commercial use. Accounts were banned (Beeper 2024; Lindy, banned on its launch day). | — | **Not in Channels.** If Martin wants it for his own account, it goes through the computer-use path (like WhatsApp groups), with the risk accepted in writing. |
| **C. RCS Business Messaging** | Rich messages to phones, iPhone included (iOS 18+, where the carrier enables it). Falls back to SMS. | Not iMessage. Needs a CPaaS provider, Google verification and carrier approval. Users usually start the chat. | 6–8 wd + provider | Possible alternative for SMS-like outreach. |

## 9. Later: WhatsApp and LINE

| Channel | Route | Key facts | Effort |
|---|---|---|---|
| WhatsApp | Meta Cloud API | Business number and Meta verification. Templates outside the 24-hour window. API groups: maximum 8 people. Cannot reach normal WhatsApp groups. | 4–6 wd + Meta setup |
| WhatsApp groups and channels | Computer use (not Channels) | Real personal account; terms risk | — |
| LINE | LINE Official Account (Messaging API) | Push, reply, broadcast; monthly message quota per plan | 3–4 wd |

## 10. Effort summary

| Item | Effort (wd) | Phase |
|---|---|---|
| Capability model v2 | 2–3 | P2 |
| Inbound worker | 5–7 | P2 |
| Buzz messages, DMs, threads, files, reactions, edits, canvas, inbound | 6–8 | P2 |
| Slack | 3–4 | P2 |
| Telegram additions | 3–4 | P2 |
| Discord additions (incl. native voice messages) | 4–5 | P2 |
| Owner screen updates for the new features | 3–4 | P2 |
| P2 part 1 subtotal | 26–35 | |
| Live-session grant model (policy, consent, receipts, owner screen) | 4–6 | P2 |
| Buzz huddle client (listen, speak-approved, speak-live) | 8–12 | P2 |
| Discord voice channels | 6–10 | P2 |
| Speech provider integration (speech-to-text, text-to-speech) | 2–3 | P2 |
| P2 part 2 subtotal | 20–30 (+ provider costs) | |
| **P2 total (one phase)** | **46–65** | |
| Teams | 6–9 | P3 |
| iMessage route A or C | 6–12 | P3 (if selected) |
| WhatsApp Cloud API | 4–6 | P3 |
| LINE | 3–4 | P3 |

## 11. Facts that are not verified

1. Buzz: the deployed relay version, PDF/text uploads, whether a server bot can use the huddle audio socket without a Desktop client in the room.
2. Teams: bot-added reactions; app-only channel posts with RSC; costs.
3. Discord: the exact Developer Policy text about voice recording.
4. Telegram: details of Bot API 10.0–10.3 features.
5. iMessage: whether an MSP is mandatory; Apple approval time.
We verify each item before we build the related part.

## 12. Decisions for Martin

1. Decided (2026-10-10): P2a and P2b are one phase (P2).
2. Decided: live voice (Buzz huddles, Discord voice) is in P2.
3. For live voice: do you accept the consent rule (every human accepts once per session before the agent stores their speech; no raw audio is stored)?
4. **Teams:** P3 (recommended) or P2?
5. **iMessage:** route A (Apple Messages for Business), route C (RCS), or not now? Do you agree that a Mac bridge stays outside Channels?
6. **Buzz:** which relay is canonical, and may we update it to a newer Buzz version?

## 13. Open item: the new kit

Martin (2026-10-10): "that new kit should be ready already". Lead · Channels asked the Coordinator which kit release this is and what it covers (Buzz huddles, voice, inbound). If the kit already gives a Buzz huddle client, speech-to-text or text-to-speech, Channels uses it and the P2 effort goes down. Candidates found on npm (2026-10-10):
1. `@tealbrick/voice` 0.3.0-rc.16 (kit release train): Portal-authorized speech-to-text and text-to-speech with configurable endpoints, and a native Eve voice channel. Channels can use it for the speech part of huddles and voice channels (replaces "speech provider integration", 2–3 wd, and the credentials go through Portal).
2. `@kybernesis/buzz` 0.10.2: puts an Eve agent in a Buzz workspace as a member (per-speaker verified identity, presence, typing, seen signals) with `nostr-tools`. It is a reference for the Buzz adapter's identity and inbound parts.
Neither package has a Buzz huddle audio client. This section is updated when the Coordinator confirms which kit Martin means.
