# Marketplace standalone 0.2.0 image

This bundle is the public Marketplace 0.2.0 release line and supersedes
0.1.19 with Channels (Telegram and Discord), owner approval proofs and the manifest instance claim.

Source snapshot: `14266b4ae544a98256125e555fe428b1307351a9`
Source archive SHA256: `dc55da12f7af5076210ae9d3e4f4f2a8bf580794531afd3719447a6c609d1620`
Image: `ghcr.io/tealbrick/marketplace:0.2.0`

## Runtime contract

* Container port: `5314`; health: `GET /healthz`.
* Persistent state: `/data/state`; optional debug logs: `/data/logs`.
* Railway source builds must set `RAILWAY_RUN_UID=0`; Railway volumes are
  root-mounted and the tracked entrypoint performs the bounded ownership
  bootstrap before dropping to uid/gid `1000`.
* Runtime user: uid/gid `1000`; the entrypoint rejects unsafe volume paths and
  does not recursively traverse or re-own mounted contents.
* Private routes require an operator session, a scoped internal bearer, or the
  exact Portal runtime lease required by that route. Health is intentionally
  the only unauthenticated liveness surface.
* Provider, Rules, and Portal values are injected at runtime and never baked
  into the image or returned to browser code.

The source-backed Railway path uses the fixed public release branch
`release-marketplace-v0.2.0` (slash-free so the Railway template editor
accepts it); its exact tag target, branch ruleset, and image
digest are recorded in the successor receipt. Set the service root directory
to `release/railway`, keep the Dockerfile entrypoint, and use the relay
contract in `deploy/railway/recipe.json` and `deploy/railway/railway-blueprint.json`.
GHCR is optional for the source-build path; no template ID or publication is
implied by these files.

## v0.2.0 Channels and manifest claim

This successor merges Tealbrick/marketplace#29 to #42:
- Channels: a channel is a connection, a destination and a policy. Telegram and Discord adapters (text, photo, file, audio, voice, video; Discord voice as audio plus transcript); owner channel setup and discovery; agent posts, holds and scheduled posts through the existing consent, Rules or owner approval, usage ledger and audit path; standing grants that can only narrow the ceiling; send-time digest re-check; receipts with retention; per-agent attachment quota; a scheduler that never resends an uncertain or partial post;
- Channels is inert until the owner adds a bot token through Portal Account Connections: no timer work, channel operations answer 409 `channels_not_configured`, and readiness is unchanged;
- the instance claim at `/.well-known/tealbrick/claim` is the contract (tealbrick.miniapp/v1) claim: Portal pins `jwksUri` and `grantKids`; the instance identity and key are the same as on `/api/tealbrick/claim`, which stays unchanged in 0.2.x;
- owner approval proofs for channel holds: Nostr proofs signed with the owner's Buzz key (32-hex digest code, refused when ambiguous or colliding, single use) and Portal proofs pinned to the claim binding; the owner key can be set only in a Portal-launched owner session once Portal has pinned the owner;
- the instance claim sends `x-tealbrick-contract` and stores the Portal owner subject; Channels reads the owner pin only from the claim binding;
- after a rollback to 0.1.19, a channel hold approved in the older Marketplace ends as skipped with a receipt and is never sent; the owner can cancel held posts;
- contract 0.1.0-alpha.7, conformance 0.1.0-alpha.5; execution targets seam in the consented call path (no behaviour change for existing targets).

New tables are added with CREATE TABLE IF NOT EXISTS only; a new file `instance-claim-binding.json` holds the claim anchors (no key). Upgrades keep the volume, variables, encrypted connector secrets and the instance claim identity. Rollback to 0.1.19 needs no data change: 0.1.19 ignores the new tables and files. During a rollback, do not approve channel holds in the older Marketplace.

## v0.1.19 connector status and Composio auth configs

This successor merges Tealbrick/marketplace#26 and #28:
- every catalog card reports a connect mode (`connected`, `needs_credentials`, `no_auth`, `ready_managed`, `ready_user_key`, `ready_auth_config`, `needs_auth_config`, `not_supported`); the catalog shows a status badge, a status filter and counts per status;
- Composio connect now uses an auth config the owner already created: a passed `authConfigId` (checked for toolkit and enabled state), then an existing custom config, then an existing managed config, before it creates one; a toolkit that needs owner setup answers 409 `composio_auth_config_required` instead of 500;
- the Connect dialog has an optional auth config ID field;
- the catalog sync records only auth-config ids and schemes, never credentials;
- the release-image publish check looks for `entrypoint.mjs`.

There is no schema change. Upgrades keep the volume, variables, encrypted connector secrets and the instance claim identity. Rollback to 0.1.18 needs no data change.

## v0.1.18 contract conformance disposition

This successor merges Tealbrick/marketplace#20, #21 and #22:
- the instance claim is also served at the canonical `/.well-known/tealbrick/claim`; `/api/tealbrick/claim` stays an alias;
- `tealbrick.app.json` (contract alpha.3, kind suite): two agent operations, `marketplace.consents.list` and `marketplace.tools.call` (idempotency key required), and 16 owner operations; agent calls run through the same consent execution as the Portal runtime lease;
- contract control endpoints, Portal-origin framing, an emergency-code login, and a settings block (the Composio key comes from the account connection as `COMPOSIO_API_KEY`);
- `/healthz` now reports only `{ok, app, version, major}`; tailnet state moved to the authenticated health route;
- Woodpecker CI replaces GitHub Actions for checks.

There is no schema change. Upgrades keep the volume, variables, encrypted connector secrets and the instance claim identity. Rollback to 0.1.17 needs no data change.

## v0.1.17 instance claim disposition

This successor merges Tealbrick/marketplace#19. It adds the Teal Brick instance claim, so Portal can register a Portal-provisioned Marketplace as a verified runtime app:
- `GET /api/tealbrick/claim` returns the stable `instanceId` and the Ed25519 public key;
- `POST /api/tealbrick/claim` signs a `tealbrick-app-claim` v1 proof for the configured Portal issuer and workspace;
- both routes need the Portal-held instance credential and refuse browser sessions.

The instance identity is created once as `instance-claim-identity.json` (mode 0600) next to the Marketplace database on the data volume. It is never overwritten. If it is lost, Portal must revoke and register the app again.

There is no schema change. Upgrades keep the volume, variables and encrypted connector secrets. Rollback to 0.1.16 needs no data change; 0.1.16 ignores the identity file.

## v0.1.16 legacy removal disposition

This successor merges Tealbrick/marketplace#18. It removes retired HDDA/Kybernesis-era surfaces that no live consumer uses:
- the HDDA Skills Hub routes (`/api/marketplace/hub/*`, `/api/plugins/marketplace-hub/records`) and their projection code;
- the Hermes per-app plugin, which the accepted miniapp contract retires in favour of the unified connector;
- the HDDA registry contracts and extension;
- the session-correlation routes.

The following stay unchanged:
- `MARKETPLACE_INTERNAL_AUTH_TOKEN` and the cross-app service routes, which Portal still uses;
- persisted manifest keys and tables;
- legacy id mapping.

There is no schema change. Company Box, the approval queue and tailnet egress are as in 0.1.15. Rollback to 0.1.15 needs no data change.

## v0.1.15 Company Box expansion disposition

This successor merges Tealbrick/marketplace#17.

New Company Box entries:
- Nextcloud 31.0.14 (OCS for the enabled apps, plus hand-authored WebDAV files, trash bin, versions and chunked upload)
- Documenso
- changedetection.io
- Chatwoot
- GlitchTip
- Forgejo
- Authentik

There are now 12 entries exposing 3233/3289 operations; every exclusion has a reason.

Engine changes:
- WebDAV methods, multi-segment paths with traversal refusal, and an origin-pinned Destination.
- Header defaults.
- Classification hardening: MOVE is destructive, `reads` patterns downgrade only POST/QUERY, and reserved header names are refused.

Google Calendar through Composio:
- A versioned Composio policy holds tools that notify attendees or share calendars in the owner approval queue.
- Destructive tools need admin.
- `composio:coverage` maps 37/38 Calendar v3 methods; `calendars.transferOwnership` has no Composio tool yet.

Upgrade and rollback:
- There is no schema change. Approval records keep the 0.1.14 table.
- Composio tools that were reclassified up to dispatch or admin need fresh grants at that capability.
- Rollback to 0.1.14 needs no data change.

## v0.1.14 Company Box disposition

This successor merges Tealbrick/marketplace#16: the Company Box collection.
- **Connectors:** each one exposes a self-hosted app's entire API from a vendored, sha256-pinned spec. The first five entries are Easy!Appointments, Postiz, Listmonk, Pretix and Formbricks: 664/680 operations exposed, 16 excluded with reasons, gated by `company-box:coverage`.
- **Agent access:** each operation is classed read, write, outward or destructive and granted per agent. Outward agent calls wait in an owner approval queue when Rules is not wired.
- **Credentials:** they stay in the encrypted store and are never sent to a changed origin.
- **Image:** the image now ships `catalog/company-box` and pinned Tailscale 1.102.5 (sha256 `65e6d7f1…8d12`). Tailscale is inert unless `TS_AUTHKEY` is set. When it is set, `tailscaled` runs in userspace mode and the key never reaches the app process. Only `*.ts.net` and CGNAT traffic uses the tailnet proxy, and health reports `tailnet: connected|unavailable|disabled`.
- **Upgrade and rollback:** with `TS_AUTHKEY` unset the runtime contract is unchanged. The `company_box_approval` table is created on start and is ignored by 0.1.13, so rollback to 0.1.13 needs no data change.

## v0.1.13 owner approval mode disposition

This successor merges Tealbrick/marketplace#15. When no `RULES_*` settings are
configured, Marketplace runs in owner approval mode: operator-session actions
are allowed and audited, agents act only with Portal-attested consent, an
unattested service-bearer execute is refused with 403, and the UI states
"Rules not connected — owner approval mode". With Rules configured, behaviour
is unchanged. Pair the upgrade with a Portal Core that removes the Rules
settings when no Rules miniapp is wired (Tealbrick/portal-core#25); 0.1.12
without Rules refuses operator installs. No schema change; rollback to 0.1.12
requires the Rules settings to be restored.

Local verification at the source snapshot: Program and web unit tests,
Playwright e2e, handoff e2e, TypeScript typecheck, production miniapp build,
and bundled Program syntax check.

## v0.1.12 operator fallback and customer UI disposition

This successor merges Tealbrick/marketplace#14 (when Rules has no lifecycle
policy for a connector install, the operator-confirmed fallback now matches the
operator role, so an operator install such as Linear is no longer refused with
`rules_denied`) and Tealbrick/marketplace#13 (the header shows the Portal
workspace name or a short id, placeholder versions are hidden, Agent grants
internals move behind "Developer details", and unconfigured optional providers
show a neutral status). No schema or contract change; rollback to 0.1.11 is
data-compatible.

Local verification at the source snapshot: Program and web unit tests,
Playwright e2e, handoff e2e, TypeScript typecheck, production miniapp build,
and bundled Program syntax check.

## v0.1.11 published UI package disposition

This successor merges Tealbrick/marketplace#10 (the Program depends on the
published `@tealbrick/ui` 0.2.2 from npm instead of the vendored
`.sdk/tealbrick-ui` copy; the build-input manifest now covers the remaining
`.sdk` sources and the lockfile pins the registry integrity) and
Tealbrick/marketplace#11 (the phone-width header Refresh control renders its
label instead of an empty box, with a Playwright assertion). Presentation and
build provenance only: no schema, configuration, route or contract change;
rollback to 0.1.10 is data-compatible.

Local verification at the source snapshot: Program and web unit tests,
Playwright e2e, handoff e2e, TypeScript typecheck, production miniapp build,
and bundled Program syntax check.

## v0.1.10 tealbrick.com site language disposition

This successor merges Tealbrick/marketplace#9: the vendored `@tealbrick/ui`
moves to 0.2.2, which carries the tealbrick.com site language (type scale,
hairline rules and button treatment) in light and dark. Presentation only:
no schema, configuration, route or contract change; rollback to 0.1.9 is
data-compatible.

Local verification at the source snapshot: Program and web unit tests,
Playwright e2e, handoff e2e, TypeScript typecheck, production miniapp build,
and bundled Program syntax check.

## v0.1.9 brand and runtime selection disposition

This successor merges Tealbrick/marketplace#6 (the runtime receiver
introspects with the canonical Portal selection shape: observe omits
`capability`, other capabilities carry it, so an agent that spells observe
out is no longer denied by the exact Portal scope comparison) and
Tealbrick/marketplace#7 (real Teal Brick logo, icons, web manifest and
light/dark tokens replacing the interim mark and theme; the Program serves
PNG and web manifest assets). No schema, configuration or contract change;
rollback to 0.1.8 is data-compatible.

Local verification at the source snapshot: 165 Program tests, 15 web tests,
17 Playwright e2e, 4 handoff e2e, TypeScript typecheck, production miniapp
build, and bundled Program syntax check.

## v0.1.8 connectors and action catalog disposition

This successor merges Tealbrick/marketplace#3 (operator custom MCP
connectors: remote HTTPS streamable-http/SSE only, outbound URL policy with
private and metadata addresses blocked and DNS re-checked per connection,
secret headers encrypted with AES-256-GCM in a new `connector_secret` table,
workspace-owned listings via a nullable `marketplace_listing.workspace_slug`
column added by an idempotent migration, Rules-gated admin and execution),
Tealbrick/marketplace#2 (published agent action catalog; grants, consents and
runtime resolve against it), and Tealbrick/marketplace#5 (Tealbrick wire
identifiers accepted alongside legacy ids; vendored UI SDK renamed to
`.sdk/tealbrick-ui` with a compatibility symlink).

Behaviour changes: connector secret writes fail closed without
`MARKETPLACE_HANDOFF_ENCRYPTION_KEY`; custom connector admin and execution
fail closed without Rules; grant requests require an installed, connected and
bound connector; dispatch and admin consents require Portal handoff v1.2
(observe consents remain v1.1-compatible). `MARKETPLACE_MCP_ALLOWED_ORIGINS`
is for fixtures only and stays unset in production. The schema change is
additive, so rollback to 0.1.7 keeps working with the same handoff key; the
new column and table are ignored by 0.1.7.

Local verification at the source snapshot: 164 Program tests, 15 web tests,
17 Playwright e2e, 4 handoff e2e, TypeScript typecheck, production miniapp
build, and bundled Program syntax check.

## v0.1.7 customer UI disposition

This successor merges the customer-readiness pass (Tealbrick/marketplace#1):
customer-safe copy and error mapping, real Program and Rules health, an
Installed empty state, Composio key test/remove with audit and an https
allowlist, the real release version from `program/package.json` (enforced
across `manifest.json` and `deploy/railway/recipe.json` by
`hygiene.test.ts`), internal-only diagnostics, safe 500 responses, phone
navigation, and Teal Brick branding in visible copy, manifests, plugin
metadata and server pages. The v0.1.6 Portal launch contract below is
unchanged. Store schema is unchanged from 0.1.6, so rollback to 0.1.6 is
data-compatible with the same handoff key.

Local verification at the source snapshot: 82 Program tests, 13 web tests,
TypeScript typecheck, production miniapp build, and bundled Program syntax
check. Source and packaged-artifact checks only; Portal rollout, provider
consent and named human UAT remain separate acceptance gates.

## v0.1.6 launch-contract disposition

This successor completes the Portal-compatible `POST /auth/launch` form adapter.
The adapter accepts exactly one form field (`ticket`), requires the exact
configured Portal Origin, rejects caller authorization headers, derives the
Portal deployment identity from server configuration, and delegates one-use
redemption to Portal with the server-held instance proof. It stores the
attested session through the existing encrypted handoff path, mints the
existing Marketplace HttpOnly operator session for the attested Portal user,
and redirects to `/` without echoing the ticket or session token. The launch
cookie uses `SameSite=Lax` for the cross-site form navigation; subsequent
mutations remain protected by the existing exact-Origin plus CSRF checks. The
legacy GET handoff remains available for compatibility.

The focused contract test covers launch-to-session, authenticated UI/status,
CSRF denial, Portal grant request, replay denial, duplicate fields, wrong
Origin, foreign deployment identity, response redaction, and encrypted
persistence. The final local verification was 68 Program tests, 5 web tests,
TypeScript typecheck, production miniapp build, and bundled Program syntax
check. These are source and packaged-artifact checks only; Portal rollout,
provider consent, customer deployment, and named human UAT remain separate
acceptance gates.

## Required server configuration

`MARKETPLACE_HOST`, `MARKETPLACE_PORT`, `MARKETPLACE_DATA_DIR`,
`MARKETPLACE_INTERNAL_AUTH_TOKEN`, `MARKETPLACE_OPERATOR_ACCESS_TOKEN`,
`MARKETPLACE_OPERATOR_ID`, `MARKETPLACE_ORGANIZATION_ID`, and exact
`MARKETPLACE_ALLOWED_ORIGINS` plus the exact callback origin
`MARKETPLACE_PUBLIC_ORIGIN` are deployment-owned settings. Set
`MARKETPLACE_HANDOFF_ENCRYPTION_KEY` to a separately managed 32-byte key before
enabling Portal handoff; it is used to encrypt handoff session bearers in
SQLite and must not be included in database backups. Generate it with
`node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'`,
store it in the deployment secret manager, and reuse the same value across
retries, restarts, upgrades, and restores. Missing or wrong keys fail closed
before migration writes. Provider OAuth
callbacks ignore caller-supplied URLs and are built only from that configured
origin. Portal v1.1
requires its issuer, audience, and instance proof. Rules-gated operation
requires `RULES_BASE_URL` and a tenant-scoped evaluation-only
`RULES_INTERNAL_AUTH_TOKEN`. Configure `COMPOSIO_API_KEY` and connected-account
references only for a separately authorized provider test or deployment.

## Release verification

The public tag workflow must verify the source archive, build-input manifest,
bundle manifest, image contents, health, and anonymous denial of a protected
route. Consumer acceptance additionally requires persistence after restart,
tenant/agent isolation, Rules deny, Portal expiry/revocation, interrupted
handoff, duplicate-event/idempotency reconciliation, and named human UAT.

The digest, source commit, build/test results, SBOM/license inventory, known
vulnerability disposition, rollback digest, and any missing provider or human
evidence belong in the release receipt, not in this image.
