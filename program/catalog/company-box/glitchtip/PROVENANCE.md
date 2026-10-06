# GlitchTip provenance

- App: GlitchTip 6.2.3 (backend tag `v6.2.3`, commit `c6e4415375d802f5cf10930f3074564960cb581a`, MIT), deployed on the `neuu` node at `https://neuu.<tailnet>.ts.net:8520`; the version is confirmed by the unauthenticated `/api/settings/`. Captured 2026-10-06.
- Source: the instance's own `GET /api/openapi.json` (unauthenticated). django-ninja generates it at runtime, so the tag has no static spec file (checked in the repo tree at `v6.2.3`). It is the deployed version, hence the exact pin. Vendored byte for byte as `openapi.json`, sha256 `f8367c3b47e6b7bb7a9fbeab83cff92e30660b03391344842ac57ac71fb9d353`. OpenAPI 3.1.0, `info.version` 1.0.0 (not the app version), no `servers` block.
- Operations: 175 (GET 90, POST 41, PUT 20, DELETE 24), all exposed, none excluded, no overlay. Paths already carry their `/api` prefix, so the base path is empty. Exposure: discovery.
- Why `openapi` and not the built-in MCP: the GlitchTip MCP (17 tools, streamable HTTP `/mcp`) covers about a tenth of the API and only `update_issue` writes.
- Outward (20, held): alert create, update and test (they notify email, Slack and webhooks), organization member invite, role change and ownership transfer, user email add and confirmation email, uptime monitor and status page create and monitor update (the server probes and notifies), event ingestion (`POST /api/{project_id}/store/`, `/security/`, `/api/embed/error-page/`: they create issues that trigger alerts), the four Stripe billing operations, the Sentry importer (`/api/0/import/`, fetches from an external server) and `wizard-set-token` (hands a token to a wizard hash).
- Destructive beyond DELETE: `members/{id}/set_owner/` (ownership transfer). The 24 DELETE operations are admin-capability by rule.
- Reads: none; every POST/PUT writes.
- Auth: `Authorization: Bearer <token>` (Profile > Auth Tokens; scopes org/project/event read and write). The spec also declares cookie `SessionAuth`, which the adapter cannot send and does not need.
- Health: `GET /api/0/organizations/`.
- Ingest endpoints authenticate with a project DSN key in the query (`sentry_key`), which the spec does not declare, so an API token alone cannot call them; they are exposed because they are in the spec.
