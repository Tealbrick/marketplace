# Marketplace

Marketplace is a standalone Fastify and React miniapp for governed plugin and
connector lifecycle. It owns catalog records, install/configure/connect/enable
state, capability and action bindings, scoped Agent grants, provider health,
execution, usage accounting, audit events, and the browser operator surface.

This `v0.1.3` public source release is the acceptance-corrected successor to
`v0.1.2` and the security-corrected `v0.1.0` line. Earlier image/tags must not be used for Portal handoff data. It
contains no
provider credentials, operator sessions, tenant data, runtime databases, or
private repository history.

## What is implemented

- SQLite-backed plugin listings, installs, connections, bindings, grants,
  usage ledger, health events, audit events, and promotion candidates.
- Fastify API with public health, authenticated operator sessions, internal
  service-bearer routes, and typed cross-app broker routes.
- React operator UI for catalog, connections, settings, audit, and Agent grant
  review. Browser code never receives service or provider credentials.
- Rules-gated connector administration and execution. Marketplace fails closed
  when Rules is unavailable, denies a request, or returns an invalid response.
- Portal v1.1 operator-consent handoff for bounded Agent connector grants.
  Portal owns human approval; Marketplace stores the attested projection and
  reconciles exact retries idempotently.
- Composio catalog/import/connection and execution adapters when explicitly
  configured. Nango, Activepieces, and MCP integration surfaces are explicit
  adapter boundaries and fail closed when their runtime is not configured or
  accepted for execution.

The schemas under `contracts/`, the extension manifest, and the Hermes adapter
describe typed integration boundaries. Hosts and other miniapps must use the
authenticated Program API; they must not read Marketplace SQLite state or
provider secrets directly.

## Security and tenancy

Set `MARKETPLACE_ORGANIZATION_ID` for the deployment-owned organization. The
operator exchanges `MARKETPLACE_OPERATOR_ACCESS_TOKEN` for a short-lived
HttpOnly session. Browser mutations require same-origin and CSRF proof.
Cross-app, Agent, and host projection routes use the server-only
`MARKETPLACE_INTERNAL_AUTH_TOKEN` or a separately scoped Portal lease. Browser
input such as workspace, actor, or agent labels is never treated as authority.

Rules and Portal credentials remain in the server runtime. Provider settings
are stored through the server-side settings boundary with private file modes;
the browser receives status and redacted projections only. Governed writes
require idempotency keys or reconciliation, and audit events retain the
decision and trace identifiers needed to inspect the operation.

Portal handoff session bearers are encrypted in SQLite with the deployment's
unique `MARKETPLACE_HANDOFF_ENCRYPTION_KEY`. Keep that key in a trusted secret
store, reuse it across retries, restarts, upgrades, and restores, and never
include it in a database backup or release artifact. A missing or wrong key
fails closed without rewriting the database.

The same key encrypts the secret headers of operator custom MCP connectors
(Connections → Custom connectors). Without it, connectors that need secret
headers cannot be saved (`connector_secret_store_unavailable`); connectors
without secrets still work. Custom connectors reach remote MCP servers over
`https://` only (streamable HTTP or legacy SSE). Loopback, private-network,
link-local/metadata, and `.local`/`.internal` addresses are refused, both at
save time and after a fresh DNS lookup before every connection; Tailscale
(`*.ts.net`, 100.64.0.0/10) endpoints are allowed. Local stdio servers are not
accepted from the browser. `MARKETPLACE_MCP_ALLOWED_ORIGINS` (comma-separated
exact origins) exists for test fixtures only.

## Local development

Requires Node `>=22.22.0` and pnpm `>=9.15.4`.

```sh
pnpm --dir program install --frozen-lockfile
TEALBRICK_MICROAPPS_ROOT="$PWD" pnpm --dir program test
pnpm --dir program typecheck
pnpm --dir program build:miniapp
```

Tealbrick environment variables use the `TEALBRICK_` prefix
(`TEALBRICK_MICROAPPS_ROOT`, `TEALBRICK_DEBUG`, `TEALBRICK_RUNTIME_FILE`,
`TEALBRICK_PRODUCT_WORKSPACE_DIR`, `TEALBRICK_MARKETPLACE_INTERNAL_AUTH_TOKEN`,
`TEALBRICK_UI_SDK_ROOT`, `TEALBRICK_APP_HOME`). The old `DOPPELGANGER_*` names
are deprecated aliases that still work and log a one-time warning. Without an
explicit data directory, state defaults to `~/.tealbrick/programs/marketplace`;
an existing `~/.doppelganger/programs/marketplace` is moved there once on
server start (a symlink is left at the old path; nothing is deleted).

For an isolated local run, set `MARKETPLACE_DATA_DIR` to a disposable
directory, provide non-production fixture tokens, and keep provider variables
unset unless a separately authorized test requires them. The packaged image
serves `/healthz` on port `5314`, stores state under `/data/state`, and runs as
uid/gid `1000` after volume checks.

## Public release boundary

The public image is built only from the tracked `release/railway/` bundle and
published by the tag workflow. Pin the consumed image by digest; a tag or a
health response is not proof of provider authorization or end-to-end tenant
acceptance. See `release/railway/RELEASE.md` for the required configuration,
storage, rollback, and verification boundary.

For the source-backed Railway path, use the pinned public-source contract under
`deploy/railway/`. Portal owns the actual Railway template and customer-project
writes; GHCR is optional and is not required for a source build.

## License

Original source and assets are MIT-licensed except where `NOTICE` identifies a
third-party asset or license. Transitive npm dependencies retain their own
licenses and are not vendored into this repository.
