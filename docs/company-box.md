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
    "basePath": "/api",                          // optional; default: Swagger basePath / first server path
    "overlay": { "file": "overlay.json", "sha256": "<64 hex>" } // optional JSON merge patch (RFC 7396)
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
  "reads": ["searchSubscribers", "POST /subscribers/query"], // POST/PUT/… that only read (optional)
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
- `reads` marks POST (or QUERY) operations that only read (search or query
  endpoints) as read-class; it never downgrades PUT, PATCH, DELETE or WebDAV
  writes (such matches are ignored and reported as coverage warnings).
  Read-class operations grant as `connector.observe` and are never outward or
  destructive unless also listed in those patterns. **Never mark a
  GraphQL endpoint as read**: the same `POST /graphql` carries mutations, and a
  read grant would let an agent run them.
- `auth` decides the credential fields the install form asks for: `header` →
  token, `basic` → username + password, `query` → API key. `mcp` entries cannot
  use `query` (keys never go in URLs).

### Overlays and engine defaults

- `openapi.overlay` is a JSON merge patch applied to the vendored spec before
  parsing, pinned like the spec. Keep supplements (missing operationIds,
  summaries, tags, removed operations via `null`) there instead of editing the
  upstream file.
- A declared parameter that carries the entry's credential (the auth header,
  `Authorization` for basic, or the query key) is dropped: Marketplace sets it.
- A `{param}` used in a path template but never declared becomes a required
  string path parameter.
- OpenAPI 3.0 `nullable: true` on a schema with no `type` (typical next to
  `oneOf` / `anyOf`) is rewritten as `anyOf: [schema, { type: "null" }]`, because
  Ajv refuses `nullable` without `type`.
- A GET cannot be gated per query parameter: if a GET has query switches that
  change state (changedetection's `recheck`, `paused`, `muted`), drop those
  parameters in the overlay so a read grant stays read-only.
- When the upstream spec omits routes the app really serves, add them to the
  overlay (new `paths` entries) and mark each operation `x-source: code`, with
  an `x-code-route` naming the route and controller it came from (Chatwoot:
  296 routes read from `config/routes.rb` and checked against the controllers).
  Say in `PROVENANCE.md` how the routes were derived and which were left out.
- A GET/HEAD operation that declares a request body is **auto-excluded**
  (`status: excluded`, `auto: true`, reason `auto: …`): bodies on GET are
  dropped or refused by servers and proxies, so sending it would not do what
  the spec says. To expose it, fix the method or body in an overlay.

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
    on Connections) with app, operation, agent and the **full** stored
    arguments as a key-sorted view (long values are visibly marked as
    truncated for display; `GET /api/marketplace/company-box/approvals/<id>`
    returns them in full, owner session only), and approves or denies it (`POST /api/marketplace/company-box/approvals/<id>/approve|deny`,
    operator session only);
  - approval runs the call **exactly once** against live state (the grant or
    consent must still be active and the action still published), records the
    result (bounded to 64 KB, else size + sha256) and audit; denial is recorded
    and the call never runs; pending requests expire after 7 days;
  - the agent polls `approvals.status`, or repeats the call with the same
    `idempotencyKey` to get the state or result (a different payload with the
    same key is refused; concurrent holds with one key share one approval).
    Only the requesting agent can read an approval. Each agent can have at
    most 50 calls waiting per workspace (`approval_queue_full`).
  Services without an agent identity still cannot run outward calls
  (`owner_approval_required_for_outward`); the owner's own session runs them
  directly.

The same queue and the same risk apply to two connector kinds whose risk
nobody has reviewed (0.2.1, QA findings F3-1 and F3-4):

- **Composio toolkits without a curated policy** (every toolkit except
  `googlecalendar`, see [google-calendar.md](google-calendar.md)): every tool
  needs `connector.dispatch` and every call is outward
  (`{ write: true, outward: true, destructive: false }`): held for the owner in
  owner approval mode, sent to Rules as outward otherwise. Tool names do not
  change this (`*_LIST_*`, `*_FETCH_*` are not trusted as reads), and a
  Portal consent at `connector.observe` cannot run such a tool. The only
  exception is the reviewed read allowlist,
  `program/catalog/composio-read-allowlist.json` (toolkit → exact tool slugs,
  observe, not outward), which ships empty. Stored listings are re-classified
  at start-up; consents minted at observe for these tools must be granted
  again at dispatch. Name-inferred admin tools stay admin.
- **Custom MCP connectors** (an operator's own server, not a Company Box
  `mcp` entry): the server's `readOnlyHint` and tool names are ignored, so
  every tool needs at least `connector.dispatch` (`destructiveHint` or a
  destructive name still means `connector.admin`) and every call is outward.
  A Company Box `mcp` entry that no longer loads is outward too. The code
  keeps one hook (`customMcpToolCapability(..., { readOnly })`) for a later
  owner-confirmed read-only flag; nothing sets it yet.

Agents see this before they call: `/api/agent/capabilities` lists `risk` for
Composio and custom MCP tools and says in the description that an outward
tool waits for the owner's approval.

## Assistant and System agents

In owner approval mode (no Rules service) each agent has one of two approval
modes. Rules mode is unchanged: Rules decides every outward call.

**Source of truth: Teal Brick Portal.** A verified app grant (introspection
answer or JWT), credential lease or handoff attachment can carry
`agentPolicy: { v: 1, approvalMode, paused, holdFamilies?, rev }`. When the
claim is present it wins over Marketplace's own settings, and the local
setting can only make it stricter: System beats Assistant, either source can
pause, and an overridable family is off only when both turn it off. A claim
with `v` other than 1, a bad `rev`, an unknown mode or a wrong type on a known
key counts as System; `paused` is true only when exactly `true`; `destructive`
and `money` in `holdFamilies` are ignored; a `rev` lower than the highest seen
for that agent is stale and counts as System for that call. Parsing lives in
one function (`parseAgentPolicy`) so it can move to
`@tealbrick/contract/approval-mode` mechanically. **The local owner settings
below (mode, pause, hold families, limits) are a temporary fallback until
Portal ships the claim; they will be removed in the next release.** Until the
contract kit passes `agentPolicy` through the app-grant introspection, the
agent-grant attachment and the runtime lease are the paths that read it.

- **System** (the default for every agent without a setting, and for an agent
  id that was removed and registered again): every outward call is held in the
  approval queue, as described above.
- **Assistant**: outward calls run at once and each one leaves a **receipt** in
  Activity (agent, connector and account, action, destination when the
  arguments name one, a redacted argument preview, result status, mode, time).
  A failed provider call also leaves a receipt. These still wait for the owner:
  - **destructive actions**: a connector's curated destructive flag and
    `connector.admin` tools (destructive by name or hint). Always held; this is
    not a family toggle;
  - **hold families** (`HOLD_FAMILIES` in `program/src/agent-approval-mode.ts`),
    all ON by default: four matched on tool-name words (deletes and resets,
    payments and refunds, sharing and permissions, bulk and broadcast; whole
    word segments, the last word may be plural, e.g. `REFUNDS`) and two
    declared by the caller (`first-contact-dm`, `live-session-grant`, passed by
    Channels). **Deletes and payments are locked ON.** The owner can turn the
    others off per workspace (Agent grants → "What still waits?", warning
    "Assistant agents will do this without asking you."). System mode ignores
    families;
  - **daily limits**: 100 outward executions per agent and 50 per agent and
    connector per **UTC day** (reset at 00:00 UTC), editable by the owner. The
    limit is checked and the execution reserved in one SQLite transaction
    before the provider call; at the limit a call is held, never dropped. Only
    executed calls count; a replay with the same idempotency key counts once.
- A hold made under System stays held after a switch to Assistant (never
  released automatically). Switching to System holds the next call.
- The mode never widens a consent: an observe consent still cannot run a
  dispatch or outward tool. Non-outward actions follow the consent in both
  modes.
- **Pause** (per agent) and **Pause all agents** are persisted kill switches:
  every call of a paused agent answers `423 agent_paused` before any provider
  call (reads and channel posts included; a scheduled post due while paused is
  skipped, not sent later), and a held call
  cannot be approved while its agent is paused. Pause also applies with Rules.
- Only the owner changes modes, limits and pauses: the owner's Portal launch
  session with its CSRF token and the pinned owner (the same gate as the owner
  Buzz key). Agents, the service bearer, runtime leases and the operator
  access-token session are refused. Every change is audited. Agents cannot
  write, edit or delete receipts.
- The 202 says why: `heldBecause` is `system_mode`, `destructive` (curated
  flag or `connector.admin`), `sensitive:<family>`, `cap_agent` or
  `cap_connector`.
- Hold-family settings: `PATCH /api/marketplace/agents/hold-families/{familyId}`
  `{on}` (owner audience `marketplace.hold-families.update`, same strict owner
  gate), audited as `marketplace.agent.hold_family.changed`; `GET
  /api/marketplace/agents` returns `holdFamilies` with the current state.
- **Reusable by Channels:** all mode logic is in `program/src/agent-approval-mode.ts`:
  `getAgentApprovalMode`, `isAgentPaused`, `decideOutward` (refuse / run / hold,
  with the atomic cap reservation; `slug` and caller-declared `families` are
  matched against the workspace's ON families), `commitCapReservation` /
  `releaseCapReservation`, `writeOutwardReceipt`, `getHoldFamilies`,
  `classifySensitive(slug, settings)` and `HOLD_FAMILIES`. Counting rule: a reservation counts unless it is
  released; commit it when the provider was reached (a failed provider call
  counts and leaves a receipt), release it when the call stopped before the
  provider. `decideOutward` is consulted only in owner governance mode; with
  Rules, Rules decides (the pause applies in both modes).
- Agents see what applies: `/api/agent/capabilities` gives each outward tool
  `approval: { system, assistant, waitsBecause? }` (and `forThisAgent` with a
  verified grant), the 202 carries `heldBecause`, and the guidance ends with the
  agent's own mode.

Owner routes (owner audience): `GET /api/marketplace/agents`,
`PATCH /api/marketplace/agents/{agentId}` `{mode?, dailyCap?, connectorDailyCap?}`,
`POST /api/marketplace/agents/{agentId}/pause|resume`,
`POST /api/marketplace/agents/pause-all|resume-all`,
`GET /api/marketplace/agents/receipts`. Coverage of the classes over the catalog
snapshots: [assistant-mode-coverage.md](assistant-mode-coverage.md).

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

## WebDAV and other spec extensions

OpenAPI has no slot for WebDAV methods, so a spec declares them as Operation
Objects under `x-<method>` keys of a path item, next to the normal methods:

```jsonc
"/remote.php/dav/files/{user}/{path}": {
  "parameters": [
    { "name": "user", "in": "path", "required": true, "schema": { "type": "string" } },
    { "name": "path", "in": "path", "required": true, "x-multi-segment": true, "schema": { "type": "string" } }
  ],
  "get": { "operationId": "downloadFile" },
  "x-propfind": {
    "operationId": "listFolder",
    "parameters": [{ "name": "Depth", "in": "header", "schema": { "type": "string", "default": "1" } }],
    "requestBody": { "content": { "application/xml": { "schema": { "type": "string" } } } }
  },
  "x-move": {
    "operationId": "moveFile",
    "parameters": [
      { "name": "Destination", "in": "header", "required": true, "schema": { "type": "string" },
        "x-destination-template": "/remote.php/dav/files/{user}/{Destination}" },
      { "name": "Overwrite", "in": "header", "schema": { "type": "string", "default": "F" } }
    ]
  }
}
```

- Supported keys: `x-propfind`, `x-proppatch`, `x-mkcol`, `x-move`, `x-copy`,
  `x-report`, `x-lock`, `x-unlock`. They count in coverage, take action keys
  like any operation (`propfind-…` without an operationId), and can be
  excluded as `PROPFIND /path`.
- PROPFIND and REPORT are reads (`connector.observe`); PROPPATCH, MKCOL,
  LOCK and UNLOCK are writes. MOVE is always destructive (`connector.admin`).
  COPY is destructive unless its `Overwrite` header is fixed with
  `const: "F"` (without the header, WebDAV overwrites). An `Overwrite`
  `default` other than `F` fails coverage. Multistatus (207) XML is returned
  as text.
- `x-multi-segment: true` on a path parameter lets its value span `/`
  (`Documents/Q3 report/notes.md`). Each segment is percent-encoded on its own;
  one leading and trailing `/` is ignored; empty, `.` and `..` segments
  (also `%2e`-encoded), backslashes and encoded slashes are refused. Other path
  parameters stay single-segment.
- `Destination` (MOVE/COPY) must declare `x-destination-template`, a path
  relative to the API base. Marketplace builds the header as the configured
  base URL's origin and prefix plus that template; `{Destination}` takes the
  caller's value as a relative multi-segment path, other `{name}`s take the
  operation's path arguments. A caller-supplied URL is never forwarded, and a
  `Destination` header without a template fails coverage.
- `Overwrite` accepts only `T`/`F`, `Depth` only `0`, `1`, `infinity`.
- A header parameter with a `default` or `const` that the agent omits is sent
  with that value (e.g. `OCS-APIRequest: true`), and it is not required in the
  schema agents see. A `healthOperation` may be any read (GET, HEAD,
  PROPFIND, …) whose required parameters all have defaults or consts.

## File uploads

In `multipart/form-data` bodies, every part declared as binary
(`format: binary`, a Swagger `file` form field, or OAS 3.1
`contentMediaType` / `contentEncoding`), and arrays of them, takes a file
object; so does an `application/octet-stream` (or `image/*`, `video/*`,
`audio/*`) body:

```json
{ "base64": "<base64 content>", "filename": "logo.png", "contentType": "image/png" }
```

Tool and `describe` schemas show this shape (marked `x-file-upload`), and
arguments are validated against it. Content must be strict base64; decoded
uploads are capped per call at 25 MB (`MARKETPLACE_COMPANY_BOX_MAX_UPLOAD_BYTES`,
error `openapi_upload_too_large`), and the execute routes accept request
bodies sized for that cap. Outward calls held for approval store their
arguments in full, so an outward upload over 32 KB is refused with
`approval_args_too_large`. Upload media through a non-outward operation first
(for example a media upload), then publish by reference.

## Request safety

- Arguments are validated against the operation's full input schema (Ajv,
  strict types, no coercion; argument groups are closed) before any request is
  built.
- Path values may not contain `/`, `\`, `%2f`, `%5c` (any case) or be `.` /
  `..` (also percent-encoded).
- Parameter and query names `_method`, `x-http-method*`,
  `x-method-override*` and any case variant of the auth query key are always
  refused: a spec declaring one fails coverage for that operation, and the
  executor checks every header it sends, defaults and consts included. A
  header `const` is enforced when the request is built; values that cannot be
  encoded (lone surrogates) are argument errors. Objects explode into query keys only for object-typed parameters,
  and only into declared keys.
- Credentials belong to the origin they were entered for. Changing an entry's
  base URL (or an MCP connector's URL) to a new origin requires entering every
  credential again; stored ones are never sent to a new host. The generic
  custom connector edit enforces the same rule for secret headers.
- Direct connections pin DNS: every address resolved at connect time is
  re-checked against the URL policy, so a name cannot rebind to a private or
  metadata address after the pre-flight check. In tailnet proxy mode the proxy
  dials and MagicDNS resolution happens inside tailscaled.
- For `mcp` entries only tools in the pinned snapshot are exposed; tools the
  live server added since are reported as `notInSnapshot` and stay unusable
  until the entry is re-pinned.

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
answer `tailnet_unavailable`. The authenticated `/api/marketplace/health` reports
only `tailnet: "connected" | "unavailable" | "disabled"`; `/healthz` carries
no tailnet state.

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
