# Channels live proof (Marketplace 0.2.0, step 1j)

`program/scripts/channels-live-proof.ts` proves the acceptance items of
`docs/channels-spec.md` section 10 (items 1 to 8) against a real Telegram chat
and a real Discord channel. **Running it live is Martin's go.** No agent runs
it against real services, and no token exists in any repo or CI.

The script builds the Marketplace app in process (temporary data directory,
fake Portal grants and consent as in `src/channels/app-fixture.ts`) with the
**production provider factories**, then drives the real agent and owner routes.
Only the two bot tokens and the test chats are real.

## Modes

| Mode | When | What it does |
|---|---|---|
| Dry run (default) | `CHANNELS_LIVE_PROOF` unset | Same flow. The real adapters talk to a simulated Telegram/Discord API (`scripts/lib/channels-proof-sim.ts`), in virtual time (about 5 s). No network: global `fetch` is blocked while it runs. Token variables in the environment are ignored. |
| Live | all interlocks below hold | Real tokens, real chats, real time (about 3 minutes per provider, because of the 60 s minimum interval and the 70 s scheduled post). |

## What Martin must prepare

Use new, empty TEST objects only. Never reuse a community chat.

**Telegram**

1. In BotFather: `/newbot`. Keep the token private. A separate test bot is
   required; do not reuse Henry's bot.
2. Create a **private** group. Add the bot. Make it a **supergroup** (for
   example turn on Topics, or set chat history to visible for new members).
   A basic group has no message links, so the "working URL" check would fail.
3. Write one message in the group that addresses the bot (for example
   `/start@<bot username>`). Discovery reads `getUpdates` once; the bot also
   needs no webhook (an active webhook gives `consumer_conflict`).
4. Find the chat id (a private supergroup id starts with `-100`):
   `curl -s "https://api.telegram.org/bot${MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN}/getUpdates" | grep -o '"chat":{"id":-[0-9]*'`,
   or read it from the URL of Telegram Web (`#-100…`).
5. The group must have **no public username**. The script refuses a chat that has one.

**Discord**

1. In the Developer Portal: new application, add a bot, copy the bot token. No
   privileged intents are needed.
2. Create a **new test server** with a **private** text channel. Deny
   View Channel for `@everyone` on that channel. The script refuses a channel that
   `@everyone` can view, unless `CHANNELS_LIVE_ALLOW_VISIBLE=1`.
3. Invite the bot with the permissions **View Channels, Send Messages, Attach Files,
   Embed Links** (nothing else). Make sure the bot can see the private channel.
4. Turn on Developer Mode in Discord, right click the channel, Copy Channel ID.

**Tokens**

The in-process run reads the tokens from the **local environment only**
(never from arguments, never printed, scrubbed from all output). The
Portal dev Account, Connections path writes the same variable names
(`MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN`, `MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN`)
as Railway shared variables for a hosted Marketplace. This script does not read
Portal. Enter the tokens without echo:

```sh
read -rs MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN && export MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN
read -rs MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN && export MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN
```

## The command

```sh
export CHANNELS_LIVE_PROOF=I_UNDERSTAND_THIS_POSTS_TO_TEST_CHATS
export CHANNELS_LIVE_TELEGRAM_CHAT_IDS=-100XXXXXXXXXX        # allowlist, comma separated
export CHANNELS_LIVE_DISCORD_CHANNEL_IDS=NNNNNNNNNNNNNNNNNN  # allowlist, comma separated
# optional: CHANNELS_LIVE_PROVIDERS=telegram   (run one provider only)
# optional: CHANNELS_LIVE_ALLOW_VISIBLE=1      (waive the Discord @everyone check)
# optional: CHANNELS_LIVE_OUT=/some/dir        (default /Users/puma/work/artifacts/marketplace-channels-0.2.0/<timestamp>/)
pnpm -C program exec tsx scripts/channels-live-proof.ts
```

Without `CHANNELS_LIVE_PROOF` the same command is the dry run (use it first).
`tsx` is already a devDependency of `program`; nothing new is installed.

### Interlocks (all required, otherwise the script prints what is missing and exits 2)

- `CHANNELS_LIVE_PROOF` equals `I_UNDERSTAND_THIS_POSTS_TO_TEST_CHATS`.
- A token in the environment for each selected provider. No command-line arguments are accepted.
- An explicit allowlist of destination ids for each selected provider. The script discovers destinations,
  uses **only** allowlisted ones and ignores the rest. A transport guard also blocks any send to a
  destination outside the allowlist, any host except `api.telegram.org` and `discord.com`, any
  unlisted API method, and more than 12 send requests per provider.
- Public destinations are refused before anything is posted: a Telegram chat with a public username
  (discovery plus `getChat`), a Discord channel that `@everyone` can view (computed from the
  `@everyone` role and the channel overwrites). If Discord's data does not allow the computation the
  script says so, skips that check and asks you to verify by hand.

## What gets posted

At most **12 per provider**; a normal run posts **7 on Telegram and 8 on Discord**. Every text is
`[tealbrick channels proof <runId> step N]` and nothing else, except one Discord message that
adds ` @everyone @here` and the voice transcript line. Attachments are a 64x64 PNG (brick pattern)
and a 1 s silent OGG/Opus file (`scripts/fixtures/silence-1s.ogg`, 346 bytes, deterministic).

Each provider gets five channels on the same destination so the live ceilings stay small:

| Channel | Ceiling | Used for |
|---|---|---|
| caps | **perDay 3, minInterval 60 s** (production default: 6 and 600 s; lowered only to keep the run short) | §10.1 post, §10.2 refusals, 3 sends then the 4th refused |
| features | perDay 6, interval 0, files png and audio/ogg, grant narrowed to perDay 5 | §10.4 narrowing, scheduled post, photo, voice, `@everyone` |
| approval | perDay 6, standing grants disabled | §10.3 per-payload approval |
| revoke | perDay 6 | §10.5 grant revoked before sendAt (post is skipped) |
| ungranted | no consent | §10.2 post returns 404 |

Steps per provider: credentials (§8), discover and allowlist, destination safety, channels,
fake consent, standing grant propose and owner approve, widening refused (§10.4), post under
grant (§10.1), min interval, duplicate phase and 404 (§10.2), two scheduled posts 70 s ahead and
one grant revoked (§10.5), per-payload approval with replay and changed text (§10.3), photo,
voice (Telegram `sendVoice`; Discord a native voice message with `IS_VOICE_MESSAGE`, duration and
waveform and no content, then the transcript as a reply), `@everyone` pings nobody (the request log shows `allowed_mentions.parse = []`),
undeclared kind `poll` refused (§10.6), scheduler tick (§10.5), posts 2 and 3 then the 4th
refused `channel_cap_per_day` (§10.2), consent revoke suspends the grant and refuses the next
post (§10.7). Last, hygiene (§10.8): both tokens are searched for in the temporary database
files, every HTTP response, all captured logs and console output, the provider request log and the
report that will be written.

Each step prints `PASS`, `FAIL` or `SKIP` with its evidence (receipt status, result ids, result
URLs, error codes). No message text beyond the tag is printed or stored. Exit codes: 0 all
steps passed, 1 a step failed, 2 refused to start.

## Evidence

`evidence.json` and `evidence.md` are written to `CHANNELS_LIVE_OUT` (live runs always; dry runs
only when the variable is set). They hold step results, the post tags with message ids and links,
request counts, and the hygiene result. They hold no token and no chat title; destination ids
only (a Telegram id without a leading minus looks like a personal chat and is hashed).

## Not covered here

- §10.6 "a 429 is retried once": a live API cannot be driven into a 429 on purpose. It is a SKIP
  in the report and is covered by `src/channels/providers/discord.test.ts`.
- §10.9 upgrade rehearsal 0.1.19 to 0.2.0 and rollback: separate, see `docs/channels-upgrade-rehearsal.md`.
- Messages are sent as a bot, so Telegram bot privacy and rate limits apply as usual.

## Clean up

1. Search each test chat for `[tealbrick channels proof <runId>` (the run id is printed, and is in
   the report) and delete those messages.
2. Remove the bot from the test group and the test server, or delete the test objects.
3. Revoke the tokens: BotFather `/revoke`; Discord Developer Portal, Bot, Reset Token.
4. `unset` the token variables. The temporary data directory is deleted by the script.

## Tests and regeneration

- `pnpm -C program exec vitest run src/channels-live-proof.test.ts` runs the flow in dry run, the
  live code path against the simulated API (interlocks, public destinations, allowlist, hygiene
  failure, transport guard, evidence). Nothing in the test suite touches the network.
- `silence-1s.ogg` comes from `scripts/lib/ogg-opus.ts` (no dependency; Opus silence frames in an
  Ogg container). Regenerate with
  `pnpm -C program exec tsx scripts/fixtures/generate-silence-opus.ts`; the test fails if the
  committed file differs from the generator.
