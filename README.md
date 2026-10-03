# Marketplace

Marketplace is a standalone Fastify and React miniapp for governed plugin and
connector lifecycle. It owns catalog records, install/configure/connect/enable
state, capability and action bindings, scoped Agent grants, provider health,
execution, usage accounting, audit events, and the browser operator surface.

This `v0.1.0` public source release is a clean snapshot. It contains no
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

## Local development

Requires Node `>=22.22.0` and pnpm `>=9.15.4`.

```sh
pnpm --dir program install --frozen-lockfile
DOPPELGANGER_MICROAPPS_ROOT="$PWD" pnpm --dir program test
pnpm --dir program typecheck
pnpm --dir program build:miniapp
```

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

## License

Original source and assets are MIT-licensed except where `NOTICE` identifies a
third-party asset or license. Transitive npm dependencies retain their own
licenses and are not vendored into this repository.
