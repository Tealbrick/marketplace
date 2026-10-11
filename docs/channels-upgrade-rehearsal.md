# Channels upgrade and rollback rehearsal (0.1.19 to 0.2.0)

`program/scripts/channels-upgrade-rehearsal.ts` rehearses the Marketplace 0.2.0
(Channels) upgrade and the rollback to 0.1.19 on one data directory. It covers
spec item 10.9, which `docs/channels-live-proof.md` leaves out. It uses no
network and no real tokens. You can run it again at any time.

## Run it

```sh
pnpm -C program exec tsx scripts/channels-upgrade-rehearsal.ts \
  [--old-ref v0.1.19] [--new-ref worktree|<git ref>] [--keep]
```

- `--old-ref` (default `v0.1.19`) is the release that you roll back to.
- `--new-ref` (default `worktree`) is the release candidate. `worktree` is this
  checkout. Any other ref is extracted with `git archive`. It uses this
  checkout's `program/node_modules` only when `program/pnpm-lock.yaml` is the
  same. If the lockfile is different, the script stops. Check out that ref, run
  `pnpm install` there, and run the script from that checkout with
  `--new-ref worktree`.
- `CHANNELS_REHEARSAL_OUT` sets the evidence directory. The default is
  `/Users/puma/work/artifacts/marketplace-channels-0.2.0/rehearsal-<timestamp>/`.
- `CHANNELS_REHEARSAL_WORK` sets the parent of the temporary work directory.
  The default is the OS temp directory. The script removes the work directory
  after a PASS, unless you give `--keep`. It keeps the directory after a FAIL.
- Exit code: 0 when all phases pass, 1 when a step fails, 2 for a usage error.

The run takes about 10 seconds. Requirements: Node 24 or later (it uses
`node:sqlite`), `git` and `tar`.

## How each side runs

- **OLD**: `git archive <old-ref> release/railway` gives the prebuilt release
  bundle. The script checks every file against `bundle-manifest.sha256`. Then
  it runs `node ./dist/marketplace-program.mjs` in `release/railway`. The
  Railway image's `entrypoint.mjs` does the same import in-process when
  `TS_AUTHKEY` is not set. The script does not run `entrypoint.mjs`, because it
  requires uid 1000 or a root volume bootstrap. The process gets a random
  127.0.0.1 port, `MARKETPLACE_DATA_DIR` / `MARKETPLACE_DATABASE_PATH` in the
  temporary `data/state` (the image layout: logs go to `data/logs`), and
  random dummy values for the internal token, the handoff encryption key and the
  operator access token. It has no Portal. `COMPOSIO_BASE_URL` points to a local
  fake.
- **NEW**: `buildMarketplaceApp` runs in-process on the same database, claim
  directory and provider settings paths that `src/index.ts` uses. It has fake
  Telegram and Discord providers (`fakeProvider` from
  `src/channels/app-fixture.ts`), a fake Portal for grant introspection and a
  virtual channel clock. Global `fetch` can only reach 127.0.0.1. The fake bot
  tokens are random for each run.

## Phases and what they prove

| Phase | What happens | What must be true |
|---|---|---|
| P0 | Extract and check the OLD bundle; load NEW | The bundle matches its manifest |
| P1 | OLD starts on an empty data directory. A Composio import and a custom MCP connector with an encrypted secret header are made through the 0.1.19 API. | `/healthz` is ok; the 12 read endpoints answer 200; the claim identity file exists and is the one served. The table list, row counts, version and identity sha256 are recorded. |
| P2 | NEW starts (scheduler on). Two channels (Telegram, Discord) and consents. The agent proposes a standing grant and the owner approves it. Two scheduled posts (sendAt T0+2 min and T0+20 min). One held post on the second channel (no grant: 202). Two more held posts for phase R. NEW stops. | The phase-1 rows and the identity do not change. The 8 channel tables are added and nothing is removed. The scheduler interval is cleared by `app.close()`. |
| P3 | OLD starts again on the upgraded data directory. The Channels token variables stay set, as an image rollback on Railway leaves them. | `/healthz` is ok; every read endpoint answers as in P1; the identity does not change; the channel tables are present and 0.1.19 does not change them; the old-table row counts do not change; no scheduled post is sent. |
| R | OLD starts again. The owner approves one channel hold and denies one channel hold in the 0.1.19 approval queue. | 0.1.19 lists the channel holds and answers both decisions; nothing is sent; 0.1.19 does not change the channel rows. |
| P4 | NEW starts again with the clock at T0+22 min. One scheduler tick. The owner approves the held post. A second tick and an idempotent retry. | Channels, the grant and the posts are intact. The post that is 20 min late is `expired`. The post that is 2 min late is sent once. The held post is sent once after the owner approval. Nothing is sent a second time. The hold denied on 0.1.19 ends `skipped`. The hold approved on 0.1.19 must not stay `held`. |
| H | Hygiene and network checks | The fake bot tokens are not in any data file (database, WAL, logs), process log, response or the report. The in-process side made no fetch to a host other than 127.0.0.1. |

Known effects that the checks allow, with evidence in the report:

- Each boot of either version writes `updated_at` again on the 20 built-in
  `marketplace_listing` rows (the seed refresh). The checks permit only
  `updated_at`, and the rows that the rehearsal made must not change.
- NEW adds rows to old tables: `audit_event`, `company_box_approval` (channel
  holds), `connector_connection` (one for each channel provider),
  `marketplace_agent_consent` and `marketplace_runtime_operation`. P3 shows
  that 0.1.19 starts and answers with these rows present.
- While 0.1.19 runs, a channel hold shows in its owner approval queue as
  `channels-<provider>` / `channel.post`. Phase R tests this case.

## Evidence

The evidence directory contains `rehearsal.json` (all phases, steps, evidence,
table lists, row counts for each phase, read-endpoint answers, refs and
shas), `rehearsal.md` (the same data in a short form), and the OLD process logs
and NEW in-process log. All secrets are redacted.

## Rerun on the 0.2.0 snapshot (Lead · Miniapps)

1. Get the release commit of the 0.2.0 snapshot.
2. Run the script from any checkout that has it:
   `pnpm -C program exec tsx scripts/channels-upgrade-rehearsal.ts --new-ref <release sha>`.
3. If the script stops because the lockfile is different, check out the
   release commit, run `pnpm -C program install --frozen-lockfile`, and then run
   the script there with `--new-ref worktree`.
4. Make sure that the P2 evidence shows the version that you expect in
   `/healthz`. On main before the release cut, it shows `0.1.19`, because
   `program/package.json` is not bumped yet.
5. Attach the evidence directory to the release receipt.

After the 0.2.0 image is cut, set `--old-ref` to the previous release if the
rollback target changes.
