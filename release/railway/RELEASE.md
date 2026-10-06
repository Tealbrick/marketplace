# Marketplace standalone 0.1.16 image

This bundle is the public Marketplace 0.1.16 release line and supersedes
0.1.15 with the retired HDDA Skills Hub adapter, Hermes plugin and registry contracts removed.

Source snapshot: `296f9b48fd8ddbd63c27e54ea5e29338ebab13f8`
Source archive SHA256: `07f1bc7be765e0f2c6b9e62083ecd0cfd9a304cd0ff9bf609be168ffad950833`
Image: `ghcr.io/tealbrick/marketplace:0.1.16`

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
`release-marketplace-v0.1.16` (slash-free so the Railway template editor
accepts it); its exact tag target, branch ruleset, and image
digest are recorded in the successor receipt. Set the service root directory
to `release/railway`, keep the Dockerfile entrypoint, and use the relay
contract in `deploy/railway/recipe.json` and `deploy/railway/railway-blueprint.json`.
GHCR is optional for the source-build path; no template ID or publication is
implied by these files.

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
