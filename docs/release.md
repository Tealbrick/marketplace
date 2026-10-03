# Marketplace 0.1.1 release boundary

This document describes the public standalone artifact. It is not a claim of
provider authorization, production readiness, or human acceptance.

## Source and image

The public source repository is `https://github.com/Tealbrick/marketplace`.
The OCI image is `ghcr.io/tealbrick/marketplace:0.1.1`; consumers should pin
the immutable digest recorded in the release receipt rather than a mutable
tag. This security-corrected release supersedes `0.1.0`, whose Portal handoff
session rows were plaintext.

The image is built from `release/railway/` with the tracked lockfile and
generated bundle. The release workflow verifies the source snapshot and the
bundle manifests before publishing. A stale generated bundle must fail the
workflow.

## Required deployment configuration

Keep all of these values in the trusted server environment or a protected
secret store. Never put them in browser configuration or a public fixture.

* `MARKETPLACE_HOST`, `MARKETPLACE_PORT`, and `MARKETPLACE_DATA_DIR`.
* `MARKETPLACE_INTERNAL_AUTH_TOKEN` for scoped service and host calls.
* `MARKETPLACE_OPERATOR_ACCESS_TOKEN`, `MARKETPLACE_OPERATOR_ID`, and
  `MARKETPLACE_ORGANIZATION_ID` for the standalone operator boundary.
* `MARKETPLACE_ALLOWED_ORIGINS` with exact HTTPS origins; do not use `*`.
* `MARKETPLACE_HANDOFF_ENCRYPTION_KEY`, a unique per-instance 32-byte key in a
  trusted secret store. Generate it with `node -e
  'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'`;
  never commit or log it, and do not place it in the database backup.
* Portal issuer, audience, and instance proof variables when the Portal v1.1
  handoff is enabled.
* `RULES_BASE_URL` and a tenant-scoped evaluation-only
  `RULES_INTERNAL_AUTH_TOKEN`; Marketplace must fail closed on deny, invalid
  response, or outage.
* Provider variables such as `COMPOSIO_API_KEY` only when an independently
  authorized provider connection is required. Provider credentials stay
  server-side.

## Storage and recovery

Mount a private persistent volume at `/data`. The image uses `/data/state` for
SQLite state and `/data/logs` for optional debug logs. Back up the SQLite file
and protected settings before upgrades, but store the handoff encryption key
separately. Restore the database and settings into an isolated instance, load
the exact same key before starting, and run health, auth, tenant, Rules,
Portal, and idempotency checks before cutover. Do not rotate the key for a
retry, restart, or routine upgrade. A wrong or missing key must fail closed
without rewriting the restored files. Rollback from `0.1.1` to `0.1.0` is
only valid with a pre-`0.1.1` backup that contains no encrypted handoff rows;
otherwise restore the prior image and its pre-upgrade backup together.

## Acceptance checklist

1. Pull the exact image digest anonymously from a clean host.
2. Start with synthetic configuration and verify `/healthz`.
3. Verify unauthenticated domain routes deny access and browser bootstrap is
   redacted until an operator session is established.
4. Verify a second organization and an unbound agent cannot read, grant, or
   execute the first organization's connector state.
5. Verify Rules deny, expired/revoked Portal approval, interrupted handoff,
   duplicate idempotency keys, and restart/reconciliation behavior.
6. Verify persistence after restart and capture the exact image digest, source
   commit, test commands, audit events, and missing human/provider UAT.
