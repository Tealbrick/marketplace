# Formbricks provenance

- App: Formbricks 6.0.2 (`ghcr.io/formbricks/formbricks:6.0.2`, upstream latest). Captured 2026-10-06. The instance serves no spec endpoint, so the upstream docs specs at tag `6.0.2` are used.
- Vendored `openapi.json` merges the four upstream documents (sha256 of each upstream file below). Paths carry their full `/api` prefix (v2 and the legacy root were relative to `/api/v2` and `/api`), components are namespaced `v1_`, `v2_`, `v3_`, `root_` so same-named schemas cannot collide, every operation gets a generation tag (`api-v1`, `api-v2`, `api-v3`, `legacy-root`) and a `[API vN]` summary prefix, and the legacy root operation ids are prefixed `legacyRoot`. v2 operations without their own `security` inherit the document-level `apiKeyAuth`. Two upstream defects are fixed. First, v1 declares the API key as a required `x-api-key` header parameter on 26 management operations; the connector already sends the key and refuses caller-supplied credential headers, so those 26 parameters are removed. Second, v1 `PUT /api/v1/client/{workspaceId}/responses/{responseId}` uses `{workspaceId}` in its path without declaring the parameter, so no caller could supply it; the parameter is added (the v2 equivalent declares it). Nothing else is changed. Vendored sha256 `d67e3eea1aaa67bb2227f44b4da8bab5b3ca262925b4cfe5c4588b5b7236b040`.

| Generation | Upstream file | Upstream sha256 | Ops | Status |
| --- | --- | --- | --- | --- |
| v1 | `docs/api-reference/openapi.json` | `e2bc1bfd186fca0cabb21f6e320109fe654b28536f74a67b05d43a45084e762d` | 32 | current, all exposed |
| v2 | `docs/api-v2-reference/openapi.yml` | `6b83214a2f72ea3fc49df82eb135ddf6d7963723295edea2c4feef526e502d61` | 40 | current, all exposed |
| v3 | `docs/api-v3-reference/openapi.yml` | `6a00efe0ddaedeb010aeae5153a7afe55ec0cea1cda690bac198275dfa75fe75` | 36 | current, all exposed |
| root | `openapi.yml` | `bcd488e71451bacada9021f3fc2fd9773bd9081876b61a262eeca611ebc86e29` | 5 | legacy, excluded |

- Decision: the generations are different resources of one product, not copies. v1 holds survey, action class, contact read, storage and single-use link management, v2 holds responses, contacts, webhooks, teams, users and roles, v3 holds surveys, workflows, tags and feedback records. Overlaps (responses, webhooks, contact attribute keys, health, client API) are all still current in 6.0.2, so all of v1, v2 and v3 are exposed. Only the legacy root document (`/api/responses`, same five operations and ids as v2 `/management/responses`) is fully superseded; each of its five operations is excluded with its own reason naming the v2 successor.
- Operations: 113 total, 108 exposed, 5 excluded. Exposure: above the 64-operation limit, so `auto` selects discovery.
- Outward (26, held for approval): survey create/update that can publish (v1, v3), response writes that run webhooks and notification pipelines (management and client, v1 and v2), public file upload, webhook create/update, user invite and role change, team and workspace-team writes, workflow enable and test. Destructive beyond DELETE: tag merge.
- Auth: `x-api-key: <key>` (Organization settings > API Keys; choose workspace access read/write/manage). The public client API ignores it. Feedback-record operations need the Enterprise licence.
- Base URL at install: the app origin (`WEBAPP_URL`). Deployed on the `neuu` node behind tailscale serve: `https://neuu.<tailnet>.ts.net:8511`.
- Health: `GET /api/v2/me` (`me`; it verifies the API key, unlike the public health check).
