# Marketplace standalone 0.1.10 image

This bundle is the public Marketplace 0.1.10 release line and supersedes
0.1.9 with the tealbrick.com site language (@tealbrick/ui 0.2.2).

Source snapshot: `5d31fa5f2fca2ec8f05878ffd399e74d078dc99e`
Source archive SHA256: `5eece3b46df484c1789746d76514cac1df8746e9252fef111225a39ad1198dfa`
Image: `ghcr.io/tealbrick/marketplace:0.1.10`

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
`release-marketplace-v0.1.10` (slash-free so the Railway template editor
accepts it); its exact tag target, branch ruleset, and image
digest are recorded in the successor receipt. Set the service root directory
to `release/railway`, keep the Dockerfile entrypoint, and use the relay
contract in `deploy/railway/recipe.json` and `deploy/railway/railway-blueprint.json`.
GHCR is optional for the source-build path; no template ID or publication is
implied by these files.

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
