# Company Box

Company Box is a curated Marketplace collection (`id: company-box`) of
self-hosted apps on your tailnet. Each app gets **one connector that exposes
its entire API toolkit**: installed once per workspace, granted per agent,
credentials kept in Marketplace's encrypted connector secret store, outward
actions held for approval.

Two kinds of entry:

| Source | What Marketplace runs | Use when |
| --- | --- | --- |
| `openapi` | A Marketplace-hosted REST adapter driven by a vendored, pinned OpenAPI 3.x or Swagger 2.0 document. Every operation is one action. | The app publishes an OpenAPI/Swagger spec. |
| `mcp` | The app's official remote MCP server, installed through the custom remote MCP path, checked against a vendored `tools.json` snapshot. | The app ships an official MCP server that covers its API. |

## Adding an entry

1. Create `program/catalog/company-box/<id>/` (`<id>`: lowercase letters,
   digits and dashes, 2–32 chars; the directory name must equal `id`).
2. Vendor the spec next to it: `openapi.json` / `swagger.json` (JSON only, self-contained:
   external `$ref`s are refused), or `tools.json` for an MCP entry
   (`{ "server": {name, version}, "capturedAt", "tools": [...] }` exactly as `tools/list` returned it).
3. Pin it: `shasum -a 256 <file>` into `entry.json`. A changed file without a new
   pin fails to load.
4. Write `entry.json` (shape below).
5. Run `pnpm run company-box:coverage` from `program/`. It writes
   `coverage.json` and `COVERAGE.md` into the catalog directory and exits
   non-zero on any gap. Commit both.

### `entry.json`

```jsonc
{
  "schema": 1,
  "id": "listmonk",
  "displayName": "Listmonk",
  "description": "Newsletters and mailing lists.",
  "category": "Marketing",                       // optional
  "app": {
    "version": "4.1.0",                          // pinned upstream app version
    "homepage": "https://listmonk.app",          // optional
    "license": "AGPL-3.0",                       // optional
    "specSource": "https://…/swagger.json"       // optional provenance
  },
  "source": "openapi",                           // or "mcp"
  "openapi": {                                   // openapi entries
    "spec": "openapi.json",
    "sha256": "<64 hex>",
    "basePath": "/api"                           // optional; default: Swagger basePath / first server path
  },
  "mcp": {                                       // mcp entries
    "urlTemplate": "{baseUrl}/mcp",
    "transport": "streamable-http",              // or "sse"
    "tools": "tools.json",
    "sha256": "<64 hex>"
  },
  "auth": { "type": "header", "name": "Authorization", "prefix": "Bearer ", "label": "API token" },
  // or { "type": "basic" } | { "type": "query", "name": "api_key" } | { "type": "none" }
  "baseUrlExample": "https://listmonk.your-tailnet.ts.net",
  "healthOperation": "getHealth",                // openapi: a GET needing no arguments
  "outward": ["sendCampaign*", "POST /tx"],      // operations that reach people/systems outside
  "destructive": ["purge*"],                     // destructive beyond DELETE (optional)
  "reads": ["searchSubscribers", "POST /graphql"], // POST/PUT/… that only read (optional)
  "exposure": "auto",                            // "auto" | "direct" | "discovery"
  "excluded": [
    { "operation": "POST /maintenance/vacuum", "reason": "Locks the database; run it from the app." }
  ]
}
```

- Operation references are an `operationId` or `METHOD /path` exactly as in the
  spec. For `mcp` entries they are tool names.
- `outward` / `destructive` / `reads` patterns use `*` wildcards,
  case-insensitive, and match the `operationId` or `METHOD /path` (tool name
  for MCP).
- `reads` marks non-GET operations that only read (search endpoints, GraphQL
  queries) as read-class: they grant as `connector.observe` and are never
  outward or destructive unless also listed in those patterns.
- `auth` decides the credential fields the install form asks for: `header` →
  token, `basic` → username + password, `query` → API key. `mcp` entries cannot
  use `query` (keys never go in URLs).

## Coverage rules

For every entry, every operation in the pinned spec (every path × method) or
every tool in the snapshot is either **exposed** or **excluded with a reason**.
The report fails when:

- exposed + excluded ≠ total (for example an operation whose schema cannot be
  built because of an unresolvable `$ref`);
- an exclusion has no reason, names nothing in the spec, or is listed twice;
- the pin does not match, the entry is invalid, or the spec version is unsupported;
- `healthOperation` is missing, excluded, not a GET, or needs arguments.

Patterns that match nothing, and cookie parameters (which the adapter cannot
send), are reported as warnings. An entry that fails coverage is not seeded at
runtime; a listing whose entry disappears keeps its row but publishes no actions.

## How operations become actions

- **Action key**: `company-box-<id>.<segment>`. The segment is the
  `operationId` in kebab case (`listNotes` → `list-notes`), or without one,
  `<method>-<path>` with `{param}` read as `by-param`
  (`GET /notes/{id}` → `get-notes-by-id`). Collisions are resolved without
  depending on spec order: the member with the lowest `METHOD /path` keeps the
  key, the others get `-<6 hex of sha256("METHOD /path")>`. Keys follow the
  custom MCP `ACTION_KEY_PATTERN` and stay ≤ 128 chars.
- **Capability**: GET/HEAD/OPTIONS or a `reads` match → `connector.observe`;
  any other method → `connector.dispatch`; DELETE (unless in `reads`) or a
  `destructive` match → `connector.admin`.
- **Group**: each catalog action carries a stable `group` for Portal grouping:
  the operation's first tag, else its first literal path segment (kebab case),
  else `general`; MCP entries use the entry id.
- **Arguments** are grouped by location:
  `{ "path": {…}, "query": {…}, "header": {…}, "body": … }`. Parameter names live
  inside their group, so a real `user_id` query parameter never collides with
  the agent argument denylist. Only declared header parameters are sent;
  `Authorization`, the credential header, cookies and hop-by-hop headers cannot
  be supplied.
- **Schemas**: `$ref`s are resolved into a self-contained schema with `$defs`
  (recursive schemas stay finite). Tool listings carry a bounded (16 KB)
  schema; when it had to be truncated it says so (`x-truncated`) and
  `operations.describe` returns the full one.

## Exposure to agents

Every operation is published in the agent action catalog
(`/api/marketplace/v1/agent/action-catalog`) and can be granted and consented
to individually. The agent tool surface (`/api/agent/capabilities`,
`/api/agent/tools/:toolName`) has two modes, chosen by operation count
(`MARKETPLACE_COMPANY_BOX_DIRECT_MAX_OPERATIONS`, default 64) unless
`exposure` overrides it:

- **direct**: one tool per operation, `marketplace.<pluginId>.<segment>`.
- **discovery**: three tools per connector:
  - `marketplace.<pluginId>.operations.search` — `{ query?, tag?, capability?, cursor?, limit? }`,
    paginated (`nextCursor`), returns keys, titles, summaries and risk flags;
  - `marketplace.<pluginId>.operations.describe` — `{ operation }`, full schema and docs;
  - `marketplace.<pluginId>.operations.call` — `{ operation, arguments }`.

Connectors with outward operations also list
`marketplace.<pluginId>.approvals.status` (`{ approvalId }`) in both modes.
For MCP entries, `describe` serves the pinned snapshot's full input schema when
it is larger than 16 KB (the live listing keeps 16 KB), marked
`schemaSource: "snapshot"`.

In both modes grants, action bindings, capability bindings and approvals apply
to the **underlying operation key**: an agent granted only reads can search and
describe everything but can only call reads. Nothing is truncated; large lists
paginate.

## Writes, destructive and outward operations

Each execute carries a declared risk `{ write, outward, destructive }` into
governance (the same gate every connector execute uses):

- **Rules connected**: Rules receives it as `payload.risk` and Marketplace
  trusts its decision. A Rules `review` holds the call
  (`rules_review_required`) in the Rules approvals queue; a Rules policy that
  allows outward calls lets them run. Write the policy accordingly.
- **Owner approval mode** (no Rules): reads, writes and destructive operations
  follow the agent's Portal-attested grant or consent (destructive ones are
  flagged in the audit trail). Outward operations from an agent are **held**
  in Marketplace's approval queue:
  - the call answers `202 { status: "approval_pending", approvalId, expiresAt }`
    after its arguments are validated; arguments (≤ 32 KB) are stored for the
    owner and never logged, audited or returned to the agent;
  - the owner sees it under Connections → Company Box → Approvals (count badge
    on Connections) with app, operation, agent and an argument preview, and
    approves or denies it (`POST /api/marketplace/company-box/approvals/<id>/approve|deny`,
    operator session only);
  - approval runs the call **exactly once** against live state (the grant or
    consent must still be active and the action still published), records the
    result (bounded to 64 KB, else size + sha256) and audit; denial is recorded
    and the call never runs; pending requests expire after 7 days;
  - the agent polls `approvals.status`, or repeats the call with the same
    `idempotencyKey` to get the state or result (a different payload with the
    same key is refused). Only the requesting agent can read an approval.
  Services without an agent identity still cannot run outward calls
  (`owner_approval_required_for_outward`); the owner's own session runs them
  directly.

## Install, credentials and connection test

`POST /api/marketplace/company-box/<id>/setup` with `{ baseUrl, credentials }`
(operator session, governed as `connector.admin`):

- `baseUrl` must pass the outbound URL policy: `https:`, no userinfo, query or
  fragment, no local/private/link-local/metadata addresses; Tailscale CGNAT
  (100.64.0.0/10) and `*.ts.net` are allowed. The path, if any, is a prefix.
- Credentials go into the encrypted `connector_secret` table; responses, logs and
  audit rows carry names and keyed fingerprints only. Omitted fields keep their
  saved values.
- `openapi` entries install the global listing for the workspace and call
  `healthOperation`. `mcp` entries create a workspace custom MCP connector from
  `urlTemplate`, store the credential as one secret header, load the live tools
  (applying exclusions, no 200-tool cap) and record drift against the snapshot.
- `POST …/test` re-runs the check; `DELETE /api/marketplace/company-box/<id>`
  uninstalls, deletes credentials and revokes agent grants and consents.

## Usage evidence

The usage ledger stores input/output shapes, not payloads. Company Box and
custom MCP executions also record the full output's byte length and sha256
(`metadata.output`). Stored approval results are capped at 64 KB, keeping the
size and sha256 of anything larger.

## Runtime limits

REST calls re-check the URL policy (fresh DNS) on every call, use
`redirect: "error"`, a 30 s timeout, a 2 MB response cap and a 512 KB cap on
binary responses (returned base64). JSON and text responses are scrubbed of
every credential value; upstream error bodies are returned bounded (4 KB) and
scrubbed so agents can fix their calls. Logs carry codes and statuses only.

## Tailnet reachability

Company Box apps usually live on your tailnet. The Marketplace image can join
it on its own (Railway or any container host); this is **off by default** and
does nothing unless `TS_AUTHKEY` is set.

1. In the Tailscale admin console create an auth key that is **ephemeral,
   tagged and pre-authorized**, e.g. tagged `tag:tealbrick-marketplace`. Give
   the tag an ACL that allows only the app hosts' serve ports, for example:

   ```jsonc
   "tagOwners": { "tag:tealbrick-marketplace": ["autogroup:admin"] },
   "acls": [
     { "action": "accept", "src": ["tag:tealbrick-marketplace"],
       "dst": ["tag:company-apps:443", "tag:company-apps:8443"] }
   ]
   ```
2. Set `TS_AUTHKEY` (and optionally `TS_HOSTNAME`, default
   `tealbrick-marketplace`) on the Marketplace service.
3. When installing an entry, use the app's
   `https://<host>.<tailnet>.ts.net:<port>` address (from `tailscale serve`).

What the image does when `TS_AUTHKEY` is set: it starts a pinned Tailscale
(`tailscaled --tun=userspace-networking --state=mem:`, log upload disabled) as
the unprivileged app user with an outbound HTTP proxy on `127.0.0.1:1055`,
runs `tailscale up --hostname=… --accept-dns=false` with a bounded 30 s wait,
and starts Marketplace as a child process **without** `TS_AUTHKEY` in its
environment (the key goes to `tailscale up` through a 0600 file deleted right
after; never argv, logs or health). Marketplace gets
`MARKETPLACE_TAILNET_PROXY` and sends only `*.ts.net` hosts and
100.64.0.0/10 addresses through it (HTTPS via CONNECT, TLS verified end to
end); everything else stays direct. MagicDNS names resolve inside
tailscaled, so the URL policy skips local DNS for `*.ts.net` in that mode;
https-only and the private-range rules still apply. If the node does not come
up, Marketplace still starts, logs a non-secret reason, and tailnet connectors
answer `tailnet_unavailable`. `/healthz` and `/api/marketplace/health` report
only `tailnet: "connected" | "unavailable" | "disabled"`.

The image sources are `deploy/railway/image/` (Dockerfile, `entrypoint.mjs`,
`tailnet.mjs`); the release cut copies them into `release/railway/`. Tailscale
is pinned to 1.102.5 (linux/amd64) and the build fails unless the download
matches the sha256 in the Dockerfile.

## Deployment prerequisites

- **Tailnet reachability.** Either set `TS_AUTHKEY` (above) or run
  Marketplace somewhere that already reaches the tailnet with MagicDNS.
- **Catalog files.** Entries are read at startup from
  `MARKETPLACE_COMPANY_BOX_DIR`, defaulting to `program/catalog/company-box`
  next to the program. Packaged builds must ship that directory.
- **Secret storage.** `MARKETPLACE_HANDOFF_ENCRYPTION_KEY` must be set for
  credentials to be saved.
