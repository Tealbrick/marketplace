# Marketplace standalone 0.1.3 image

This bundle is the public Marketplace 0.1.3 release line and supersedes
0.1.2. The release image
contains the Fastify Program, the built browser application, the tracked
entrypoint, and no provider credentials, operator sessions, tenant data, or
runtime database.

Source snapshot: `4bb86a70621171cc546c2639a1c9675ed53a353e`
Source archive SHA256: `9f14b79272625a4ae66aab1582683163a7765d6b44ed3173cb9a27a9b0910fa9`
Image: `ghcr.io/tealbrick/marketplace:0.1.3`

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
`release/marketplace-v0.1.3` at reviewed runtime commit
`28552dcf4917c8d3bb449b13473b8645c780e9a4`; set the service root directory to
`release/railway`, keep the Dockerfile entrypoint, and use the relay contract in
`deploy/railway/recipe.json` and `deploy/railway/railway-blueprint.json`. GHCR
is optional for this path; no template ID or publication is implied by these
files.

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
