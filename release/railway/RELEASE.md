# Marketplace standalone 0.1.4 image

This bundle is the public Marketplace 0.1.4 release line and supersedes
0.1.3 for Portal browser launch compatibility. The release image
contains the Fastify Program, the built browser application, the tracked
entrypoint, and no provider credentials, operator sessions, tenant data, or
runtime database.

Source snapshot: `257aa5ca4b06031d41b0bc56c4c6f34077e419f3`
Source archive SHA256: `e777ee5f27bac96db8aec74aab0b03ab478a08f0d35f49c8d3f77d1d8e7a3f7a`
Image: `ghcr.io/tealbrick/marketplace:0.1.4`

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
`release/marketplace-v0.1.4`; its exact tag target, branch ruleset, and image
digest are recorded in the successor receipt. Set the service root directory
to `release/railway`, keep the Dockerfile entrypoint, and use the relay
contract in `deploy/railway/recipe.json` and `deploy/railway/railway-blueprint.json`.
GHCR is optional for the source-build path; no template ID or publication is
implied by these files.

## v0.1.4 launch-contract disposition

This successor adds the Portal-compatible `POST /auth/launch` form adapter.
The adapter accepts exactly one form field (`ticket`), requires the exact
configured Portal Origin, rejects caller authorization headers, derives the
Portal deployment identity from server configuration, and delegates one-use
redemption to Portal with the server-held instance proof. It stores the
attested session through the existing encrypted handoff path and never echoes
the ticket or session token. The legacy GET handoff remains available for
compatibility; this release does not claim that the existing HTML closeout
creates a Marketplace operator session.

The focused contract test covers replay denial, duplicate fields, wrong
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
