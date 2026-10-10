# Proposal: Discord voice-channel support (speak, optional listen) for Marketplace

Date 2026-10-10. Read-only research; nothing installed in any repo. Tarballs inspected in `scratchpad/dave-research/`.
Not tested: native load on Linux (inspected only on macOS), the WASM fallback, live Discord interop of any option.

## 0. Facts that drive the decision
- DAVE is mandatory for DMs, GDMs, voice channels and Go Live since 2026-03-01 ([voice docs](https://docs.discord.com/developers/topics/voice-connections)). Client must send `max_dave_protocol_version` in Identify (0 = no DAVE), use voice gateway v8, and modes `aead_xchacha20_poly1305_rtpsize` (required) / `aead_aes256_gcm_rtpsize` (preferred). Opus must be 2ch / 48 kHz. Receive is not mentioned in the docs at all.
- DAVE = MLS ciphersuite 2 (P-256, AES-128-GCM frame crypto, ECDSA P-256), protocol version 1 ([daveprotocol.com](https://daveprotocol.com/); davey source: `DAVE_PROTOCOL_VERSION = 1`).
- **Stage channels are excluded from DAVE**: [whitepaper](https://daveprotocol.com/) ("excluding stage channels") and [Discord blog 2026-05-18](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted) ("Stage channels are the one exception"). Not found in the docs: an explicit statement that a v0 client is accepted there. Stage speakers need unsuppressed voice state ([stage-instance docs](https://docs.discord.com/developers/resources/stage-instance)).
- Marketplace today: esbuild single-file bundle (`program/scripts/build-miniapp.mjs`), Dockerfile (`node:24-bookworm-slim@sha256:0e0ff4..`) copies only `dist`, `web-dist`, `catalog` -- **no `node_modules` and no install step**. Discord text gateway is already in-house on Node's built-in `WebSocket` with the stated rule "No new dependency" (`program/src/channels/discord-gateway.ts`). CI image check is Woodpecker + kaniko, `linux/amd64`. `@noble/curves 2.4.0` is already an exact pin.
- Node's OpenSSL has `aes-256-gcm`, so transport crypto needs no libsodium/tweetnacl; `@discordjs/voice` uses `node:crypto` when available (dist `getCiphers().includes("aes-256-gcm")`, else needs sodium/noble).
- Speak path needs no Opus encoder when TTS returns Ogg/Opus (Ogg demux only). Listen path yields per-user Opus packets (after transport + DAVE decrypt); STT in Ogg/Opus needs an Ogg *muxer* (about 100 lines TS: page framing, CRC32, OpusHead/Tags), no decoder. Condition: TTS packets must be 20 ms frames (check TOC byte); otherwise a re-encode (native or WASM encoder) is required.

## 1. Options
| | A: @discordjs/voice + davey | B: own thin client + davey only | C: libdave custom binding | D: pure-JS/WASM DAVE | E: defer / stage-only |
|---|---|---|---|---|---|
| Idea | Adapter to our gateway; library does voice WS/UDP/RTP/DAVE flow | We write voice WS v8, UDP, RTP, pacing, DAVE state machine on davey's primitives ([USAGE.md recipe](https://github.com/Snazzah/davey/blob/master/docs/USAGE.md)) | N-API/C++ addon over [discord/libdave](https://github.com/discord/libdave) | See section 2D | No DAVE: bot speaks only in stage channels, or nothing |
| New runtime deps | 7 pkgs + 1 native platform pkg | 1 pkg + 1 native platform pkg | 0 npm, C++ in repo | 0-1 npm | 0 |
| Native code | Rust prebuilt (davey) | Rust prebuilt (davey) | C++ we build | none (WASM or JS) | none |
| Send / receive | yes / yes (receive "not guaranteed") | yes / yes (ours) | yes / yes (ours) | yes / yes (ours or pkg) | send only, stage only |
| Fits "TypeScript only" | yes (binary from npm) | yes (binary from npm) | **no** (C++ source, cmake/vcpkg) | yes | yes |
| Effort (worker-days) | speak 5, +listen 8-9 | 14-16 | 20+ | 25+ (D1/D2), 12 (D3 pkg) | 2-3 |
| Verdict | **Recommended** | fallback if upstream stalls | reject | watch only | optional spike |

## 2. Per-option detail
### A. `@discordjs/voice@0.19.2` + `@snazzah/davey@0.1.12`
- **Licenses**: voice `Apache-2.0`; davey `MIT` (repo LICENSE MIT; the npm tarball ships no LICENSE file); ws `MIT`; tslib `0BSD`; @types/ws `MIT`; discord-api-types `MIT`; prism-media `Apache-2.0`. Rust deps under davey: openmls 0.8.1, RustCrypto (aes-gcm 0.10.3, p256) -- permissive; run `cargo license`/SBOM in CI if a license gate exists.
- **Native**: davey is NAPI-RS 3 (`napi 3.8.4`). Prebuilt optional packages: `linux-x64-gnu` (1.86 MB, needs glibc <= 2.14, links libgcc_s/libc/libdl/libpthread/librt), `linux-x64-musl` (1.87 MB), `linux-arm64-gnu` (1.53 MB, glibc 2.17), `linux-arm64-musl`, `linux-arm-gnueabihf`, darwin x64/arm64, win32 x64/ia32/arm64, android, freebsd, **wasm32-wasi (1.0 MB)**. No install script anywhere in the tree (checked `scripts` of every package); `prepublishOnly` only. **There is no compile-from-source fallback at install**; a missing platform pkg makes `require` fall through to the WASM pkg, else throw. Rust is needed only for a manual `napi build`. `NAPI_RS_NATIVE_LIBRARY_PATH` env loads any `.node` path (trusted env only).
- **Supply chain**: both published with npm SLSA v1 provenance (verified `dist.attestations`, also on the linux-x64-gnu pkg). No GitHub advisories for voice, davey, prism-media. Downloads last week: voice 513k, davey 483k, prism-media 547k. davey: single maintainer (snazzah; 143 of ~150 commits), 12 releases in 15 months, last npm 0.1.12 on 2026-06-22, repo active (last push 2026-09-26), 3 open issues, 0.x API. voice: maintainers crawl, hydrabolt; discord.js is 26.8k stars, 1525 npm versions (mostly dev builds). **Stable 0.19.2 is dated 2026-03-17**; `main` is `1.0.0-dev` (Node >= 24.17.0, breaking changes). prism-media 1.3.5: last release 2023-02-27, repo last push 2023-07-18, 25 open issues -- stale but tiny (44 KB, zero deps, optional-only peers).
- **Advisories to handle**: voice pins `ws ^8.19.0`; ws is hit by GHSA-96hv-2xvq-fx4p (high, DoS, fixed 8.21.0) and GHSA-58qx-3vcg-4xpx (medium, fixed 8.20.1). Override to exact `ws@8.22.0` (latest).
- **Open upstream bug that touches listening**: [discord.js#11653](https://github.com/discordjs/discord.js/issues/11653) (2026-10-08): in 0.19.2 and `main`, DAVE decrypt never recovers after an MLS welcome at transition 0 (bot joins a populated channel; receive streams die). Speak path is unaffected. Needs a `pnpm patch` or an upstream fix before listen ships. Also [davey#18](https://github.com/Snazzah/davey/issues/18) (decrypt allocates; perf only).
- **Node**: voice `>=22.12.0` (stable line; the 24.17 figure belongs to the 1.0.0-dev line). Marketplace `>=22.22.0` and the image Node 24 both satisfy it. Davey `>=10`.
- **Size / Docker**: voice 820 KB unpacked, discord-api-types 3.3 MB (types mostly; bundler tree-shakes enums). Plan: bundle all JS into `dist`; mark only `@snazzah/davey` external (esbuild cannot bundle `.node`); add a small install stage that copies exactly `@snazzah/davey` + `@snazzah/davey-linux-x64-gnu` from the lockfile (about +1.9 MB image). glibc: base image is bookworm (2.36), OK; musl variant exists if the base ever moves to Alpine. Build adds one npm-registry fetch (integrity-pinned); the existing sha256-pinned Tailscale download stays the only non-npm fetch. Build time impact: seconds.
- **Interface to us**: `joinVoiceChannel({adapterCreator})` needs a `DiscordGatewayAdapterCreator`: send op 4, feed back `VOICE_STATE_UPDATE` and `VOICE_SERVER_UPDATE`. Our gateway needs intent `GUILD_VOICE_STATES` (1<<7, non-privileged) added only when voice is enabled. Speak: `createAudioResource(oggStream,{inputType:StreamType.OggOpus})`. Never use `Arbitrary`/`Raw` (those pull FFmpeg or an Opus encoder). Listen: `receiver.subscribe(userId)` gives Opus per user.
- **Risk**: upstream churn (1.0 breaking), one-person native dep, stale prism-media. Mitigate: exact pins, a `VoiceTransport` seam of about 6 methods so B can replace A.

### B. Own thin client + `@snazzah/davey` only
Drops ws, prism-media, discord-api-types, tslib, @discordjs/voice (6 packages). Uses Node `WebSocket`, `node:dgram`, `node:crypto` (aes-256-gcm), and a small TS Ogg demuxer (about 150 lines; `@slipher/voice` `lib/media/ogg.js` shows the size). Same native/supply-chain/Docker profile as A for davey. Cost: we own reconnect/resume, SSRC mapping, transition handling, 20 ms pacing, silence frames, speaking op 5, and the DAVE state machine that upstream still gets wrong at the edges (#11653). Fits our "no new dependency" precedent best, but +6-8 days and more security surface.

### C. libdave via custom binding
[libdave](https://github.com/discord/libdave): `MIT`, C++ (cpp/) + JS helper package `@discordapp/libdave` (private, not on npm; fingerprint/verification code only, plus a wasm build not published). Releases `v1.2.1/cpp` (2026-09-22), `v1.2.0`, `v1.1.1`; 284 stars, no advisories. Needs mlspp + OpenSSL 1.1/3 or BoringSSL via vcpkg submodule, cmake, a C++ compiler in CI, plus our N-API glue per arch. Violates "TypeScript only", slows kaniko builds (minutes), adds an arch matrix. Reject; davey already gives a maintained binding of the same protocol.

### D. WASM / pure-JS DAVE
- D1: davey's own `@snazzah/davey-wasm32-wasi@0.1.12` (MIT, 1.0 MB, needs `@napi-rs/wasm-runtime` 6 MB + threads/SharedArrayBuffer; its Node loader preopens the filesystem root via `node:wasi`). Automatic fallback inside davey. Useful as a no-native emergency path, not a primary (untested, slower, broad preopen).
- D2: `@slipher/voice@0.1.0` (MIT per package.json; no LICENSE file, GitHub repo license null; published 2026-09-22; 131 downloads/month; no provenance; peer `seyfert >=5`): a package-owned pure-TS MLS + DAVE + voice gateway on `@noble/*` only. Real and interesting (matches our noble pin) but 3 weeks old, one author, Seyfert-coupled gateway, no interop evidence. Reference only.
- D3: build on `ts-mls@1.6.4` (MIT, provenance, `@hpke/core`) + own DAVE layer: security-sensitive crypto we would own. Reject for now.
- `socket-dave`, `discord-voip` (7.2.0), `@ovencord/voice` (Bun only) found; all use davey or Lavalink; none is a DAVE implementation.

### E. Defer, or stage channels only
Stage channels are not E2EE, so a thin B-without-davey client (`max_dave_protocol_version: 0`, no natives) could speak there. Unverified: acceptance of v0 identify on stage channels (docs silent). Needs the bot to join, then be unsuppressed (a moderator with `MUTE_MEMBERS` or a request-to-speak flow). Product value is low (broadcast rooms, not conversation) and the work is thrown away once DAVE exists. Valid only as a 1-day feasibility spike.

## 3. Interaction with Marketplace rules
- **Exact pins**: pin `@discordjs/voice 0.19.2`, `@snazzah/davey 0.1.12`, `@snazzah/davey-linux-x64-gnu 0.1.12`, `prism-media 1.3.5`, `tslib 2.8.1`, `ws 8.22.0` (override), `discord-api-types` exact 0.38.x. Install with `--frozen-lockfile --ignore-scripts` (no package needs scripts).
- **Inert unless configured**: dynamic `import()` of the voice module only when a voice channel config + grant exists; no `GUILD_VOICE_STATES` intent, no UDP socket, no native load otherwise. A missing/broken davey must fail closed with a fixed status reason, never crash the text gateway.
- **CI**: Woodpecker `image.yaml` builds with kaniko `linux/amd64`; add one check that `node -e "require('@snazzah/davey').DAVE_PROTOCOL_VERSION"` loads inside the built image (catches wrong-libc packages). Dockerfile change goes in the template (`deploy/railway/image/Dockerfile`), not the generated copy.
- **Live-session grant model (assumed from the brief; not yet read)**: speak and listen as separate modes. Speak needs a session grant plus an audible/visible disclosure. Listen is off by default, needs its own owner-approved grant, a per-session expiry, no audio persisted (stream to STT only), transcripts under existing channel retention, and a channel notice that the bot transcribes. One voice connection per guild; tie the lease to the existing gateway consumer lease.
- **Receive is undocumented by Discord**; library support is best effort ([voice README](https://github.com/discordjs/discord.js/tree/main/packages/voice#about) says "not guaranteed"). Treat listen as beta behind its own flag.
- **Discord Developer Policy**: could not read. `docs.discord.com/developers/policies-and-agreements/developer-policy` redirects to `support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy`, which returned HTTP 403 (also 403 via curl). A search snippet only shows: no training ML/AI models on message content obtained via API without permission, and no actions on a user's or server's behalf without clear permission. Voice data handling is therefore **unverified**; a human must read it.

## 4. Recommendation
Option A in two phases, behind a `VoiceTransport` seam so B can replace it.
- Minimal set: `@discordjs/voice@0.19.2` (brings `ws`, `tslib`, `prism-media`, `discord-api-types`, `@types/ws` as types), `@snazzah/davey@0.1.12` + `-linux-x64-gnu`, `ws` override 8.22.0. No Opus lib, no sodium, no FFmpeg, no Rust toolchain.
- Phase 1 speak (about 5 worker-days): adapter + intent, TTS Ogg/Opus path with 20 ms check, bundle externals + Docker install stage + CI load check, grant/disclosure wiring, fake-adapter tests. Phase 2 listen (about 3-4 days): per-user receive, Ogg muxer to STT, patch for #11653, live proof in a real guild. Total about 8-9 days (live proof needs a test guild and bot token; Martin handles keys).
- Re-evaluate B if upstream 1.0 breaks us or davey goes unmaintained for more than 6 months; keep D2 and the WASM fallback as watch items.

Open questions for the Coordinator:
1. Is a prebuilt native npm addon acceptable under "TypeScript only" plus the "no new dependency" precedent? It forces the first `node_modules` in the image.
2. Who reads the Discord Developer Policy (403 for us) and approves listen/transcribe scope and disclosure text?
3. Ship speak-only first, listen later (recommended)? Is waiting for a fix to #11653 acceptable, or do we carry a patch?
4. Which TTS/STT providers, and can TTS be pinned to 20 ms Ogg/Opus frames (stereo vs mono to verify with Discord)?
5. Is Railway amd64-only (assumed from Dockerfile and CI label)? If arm64 appears, `linux-arm64-gnu` exists.
6. Do we want the 1-day stage-channel spike, or skip E?
7. Stable 0.19.2 now, or wait for `@discordjs/voice` 1.0 (Node >= 24.17, breaking)?
