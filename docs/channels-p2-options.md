# Channels Phase 2: options for Martin

Status: options, 2026-10-09. Author: Lead · Channels. Decision: Martin.
This document is in ASD-STE100 Simplified Technical English. It is a design only. There is no code.
It uses the Phase 1 rules: one execution path, the capability declaration (spec §3.1), owner approval of the exact payload, standing grants, receipts.

## 1. Summary of the options

| # | Option | What agents get | Effort | Risk | Recommendation |
|---|---|---|---|---|---|
| A | Discord native voice messages | A voice note in a Discord text channel that plays like a recorded message | 1–1.5 worker-days | Low | Do it in P2 |
| B | Discord voice channel: play an approved audio clip | The bot joins a voice channel, plays one approved clip, and leaves | 4–6 worker-days | Medium | Do it after A, if you need live events |
| C | Discord voice channel: live conversation (speech-to-text in, text-to-speech out) | The agent listens and speaks in a voice channel | 10–15 worker-days | High | Do not start now |
| D | Slack channels | Posts, files, scheduled messages, link buttons in Slack | 2–3 worker-days | Low | Do it in P2 |
| E | WhatsApp through the official Cloud API | Posts to opted-in contacts and to small API groups (8 people maximum) | 4–6 worker-days + Meta business setup | Medium | Only if you have a WhatsApp business number |
| F | WhatsApp through computer use (Codex) | Posts to normal WhatsApp groups and channels | Not in Channels | High (terms of service) | Keep on the Henry desktop path, not Channels |

## 2. Option A: Discord native voice messages

What it is: Discord shows a voice message with a play button and a waveform.

Facts (Discord API):
- The file must be OGG/Opus.
- The message must have the flag `IS_VOICE_MESSAGE` (8192).
- The attachment must have `duration_secs` and a `waveform` (base64, up to 256 values from 0 to 255). Without them, Discord refuses the message (error 50161).
- A voice message can have no other content. It can have no text and no embeds.

Design:
1. The Discord adapter changes `voice` from `{fallback: "audio+transcript"}` to `{native: true}`.
2. Marketplace calculates the duration and the waveform from the OGG file. It does not use a new library. The Phase 1 OGG code is the start point.
3. A transcript cannot go in the same message. If the agent gives a transcript, Marketplace sends it as a second message. This is a two-step post. The Phase 1 rule applies: if the second step fails, the post is `uncertain`, never `failed`.
4. The owner approves one digest that covers the audio file, the waveform, the duration and the transcript.

Effort: 1–1.5 worker-days.

## 3. Option B: Discord voice channel, approved clip playback

What it is: the bot joins a voice channel, plays one audio clip, and leaves. Example: a short spoken announcement at the start of an online meetup.

Facts:
- Discord voice uses the gateway (a WebSocket connection) and a voice connection (UDP).
- Since 2 March 2026, every voice call on Discord uses end-to-end encryption (the DAVE protocol). Bots without DAVE support cannot join calls.
- The `@discordjs/voice` library supports this. It adds dependencies (gateway client, Opus, DAVE).

Design:
1. A new operation `marketplace.channels.voice-play` (create, external-effects). It is outward.
2. The payload is the audio clip, the voice channel and a time window. The owner approves the digest of the audio bytes.
3. A small in-process voice worker joins, plays the clip once, and leaves. Maximum clip length: 5 minutes.
4. The capability is `voiceChannel: {play: true, listen: false}`.
5. The receipt records the join time, the play time and the leave time.
6. Standing grants can cover clip playback with the same caps as posts.

Caution: the gateway connection is a persistent worker. Marketplace runs one replica, so one worker is sufficient. This is the same worker that inbound messages need in Phase 4.

Effort: 4–6 worker-days.

## 4. Option C: Discord voice channel, live conversation

What it is: the agent listens to people in a voice channel (speech-to-text) and answers with speech (text-to-speech).

Problems:
1. **Approval.** The owner cannot approve each spoken sentence before it is said. Live speech needs a new kind of standing grant: a "live session grant" with a time limit, a topic, a word list that is not permitted, and a full transcript as the receipt. This is a new policy model. It is not a small change.
2. **Privacy.** Listening records the voices of other people. Discord requires that the bot tells people that it records. Some countries require consent from each speaker. We must store the audio only for the time that speech-to-text needs, and store only the transcript.
3. **Cost and quality.** Speech-to-text and text-to-speech need model providers. Each provider has a cost per minute and a delay.
4. **Engineering.** Real-time audio, turn-taking and interruptions are difficult.

Recommendation: do not start Option C now. Do Option B first. Then decide with real use.

Effort: 10–15 worker-days, plus provider costs.

## 5. Option D: Slack channels

Facts (Slack Web API):
- A Slack app with a bot token (`xoxb-`) posts with `chat.postMessage`.
- File upload uses `files.getUploadURLExternal` and then `files.completeUploadExternal`. The old `files.upload` method stopped on 12 November 2025.
- `chat.scheduleMessage` gives native scheduled messages.
- Formatting is `mrkdwn`. Buttons use Block Kit.

Design:
1. A Slack adapter with the Phase 1 pattern: a thin client on `fetch`, the capability declaration and token scrubbing.
2. Capabilities: text, `mrkdwn`, images, files, `schedule.native`, link buttons. Mentions `@channel`, `@here` and `@everyone` are always suppressed.
3. File upload has three steps. If a step fails after the file is shared, the post is `uncertain`.
4. Discovery: `conversations.list` for public channels where the bot is a member. For private channels, the owner must invite the bot first.
5. The credential is a bot token in Account Connections. The setting name is `MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN`.

Effort: 2–3 worker-days.

## 6. Option E: WhatsApp through the official Cloud API

Facts (Meta WhatsApp Cloud API):
- You need a WhatsApp Business account and a business phone number, with Meta verification.
- One-to-one messages: outside a 24-hour customer window, you can send only approved message templates. Each contact must opt in.
- Groups: Meta added a Groups API. Its limit is 8 participants per group, and it needs an Official Business Account. Meta charges each delivered group member.
- Group messages can be text, images, video, PDF and text templates. They cannot have interactive buttons.

Design:
1. A WhatsApp adapter for the Cloud API, with the Phase 1 pattern.
2. Destination kinds: one opted-in contact (`chat`) or one API group (`group`, 8 people maximum).
3. Policy: templates are mandatory outside the 24-hour window. The owner approves each template text once. The adapter refuses a free-text message outside the window.
4. Costs are shown in the receipt and in the channel view.

Caution: this does NOT reach normal WhatsApp groups or WhatsApp channels with many people. The Cloud API cannot post there.

Effort: 4–6 worker-days, plus the Meta business setup, which you must do.

## 7. Option F: WhatsApp through computer use

What it is: Codex operates WhatsApp on a device and posts to normal groups or channels.

Decision already made (2026-10-09): platforms without an API use Codex computer use with approval of each post. They are not part of Channels. The Henry desktop tool (`henry_desktop`) is the path.

Why it stays outside Channels:
- It uses a real personal account and a real device. It is not a governed API.
- WhatsApp terms prohibit unofficial automation. There is a risk that WhatsApp blocks the number.
- It cannot give a reliable receipt.

Possible small link (optional, 0.5 worker-days): Channels can show a list of "external destinations" with links to the Henry desktop receipts, so the owner sees all outward posts in one place. Channels does not send to them.

## 8. Recommended Phase 2 scope

1. A: Discord native voice messages (1–1.5 worker-days).
2. D: Slack channels (2–3 worker-days).
3. The Phase 2 items that are already planned: email, Listmonk, Discord scheduled events, reply-to, link buttons, polls, reactions, edits and deletes, Telegram `markdown-v2` (about 7 worker-days).
4. B (voice channel clip playback): only if you need spoken announcements in live events.
5. E (WhatsApp Cloud API): only if you have, or want, a WhatsApp business number.
6. C: not now.
7. F: not in Channels.

## 9. Decisions for Martin

1. Do you approve A and D for Phase 2?
2. Do you need B (spoken announcements in Discord voice channels)?
3. Do you have, or do you want, a WhatsApp business number for E?
4. Do you agree that C waits and F stays outside Channels?

## Sources

- Discord, "Every Voice and Video Call on Discord Is Now End-to-End Encrypted": https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted
- Discord support, "Minimum Client Version Requirements for Voice Chat": https://support.discord.com/hc/en-us/articles/38025123604631-Minimum-Client-Version-Requirements-for-Voice-Chat
- Discord developer docs, Message object (flags, voice messages): https://docs.discord.com/developers/resources/message
- Slack changelog, "The files.upload method is retiring": https://docs.slack.dev/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay
- Unipile, "WhatsApp Group API 2026: Limits, Endpoints & Alternatives" (secondary source; confirm in Meta docs before build): https://www.unipile.com/whatsapp-group-api/
