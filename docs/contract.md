# Teal Brick miniapp contract

Marketplace follows the Teal Brick miniapp contract (`tealbrick.miniapp/v1`,
kit `@tealbrick/contract` pinned at `0.1.0-alpha.3`). The manifest is
`tealbrick.app.json` at the repository root. It is validated at start-up and
served at `/.well-known/tealbrick/manifest`. Validate it in CI with:

```sh
npx -y @tealbrick/contract@0.1.0-alpha.3 validate tealbrick.app.json
```

Nothing in this document changes the existing Portal paths: the instance
claim, the Portal launch hand-off, the runtime lease receiver, connector secret
encryption (`MARKETPLACE_HANDOFF_ENCRYPTION_KEY`) and operator sessions work as
before. See `docs/instance-claim.md` for the claim.

## Kind

`kind` is `suite`. A `bridge` wraps one open-source upstream that runs as a
pinned service beside the app. Marketplace pins none: Composio is a hosted
service reached over its API with the account key, and Nango and Activepieces
are optional external adapters that Marketplace does not run or version-pin.
If one runtime is pinned as a sidecar later, the manifest can move to `bridge`
with that `upstream`.

## Operations

| Audience | Operation | Route |
| --- | --- | --- |
| agent | `marketplace.consents.list` | `GET /api/marketplace/v1/agent/consents` |
| agent | `marketplace.tools.call` | `POST /api/marketplace/v1/agent/tools/call` |
| owner | `marketplace.consents.request` / `.redeem` / `.revoke` | `/api/marketplace/v1/agent/grants/request`, `/redeem`, `/api/marketplace/agent/grants/{grantId}/revoke` |
| owner | `marketplace.connections.connect` | `POST /api/marketplace/plugins/{pluginId}/connection` |
| owner | `marketplace.plugins.install` / `.uninstall` / `.register` / `.unregister`, `marketplace.catalog.import` | `/api/marketplace/plugins/{pluginId}/...`, `/api/marketplace/catalog/composio/import` |
| owner | `marketplace.settings.get` / `.update` / `.clear` | `/api/settings/providers/composio` |
| owner | `marketplace.approvals.list` / `.get` / `.approve` / `.deny` | `/api/marketplace/company-box/approvals...` |

Owner operations are for the owner's UI session (or the internal service
bearer). A Portal app grant never reaches them: the answer is `403
{"error":"operation_owner_only"}`. A route that is not declared answers `403
{"error":"operation_unknown"}`.

### `marketplace.consents.list`

Returns only the calling agent's active consents:
`{ok, schema, consents: [{consentId, toolkit, actions, state}]}`. `toolkit` is
the Marketplace connector id (`pluginId`). One consent covers one action, so
`actions` has one entry. It carries no credential and no account id.

### `marketplace.tools.call`

Body `{consentId, toolkit, action, arguments}` and an `Idempotency-Key` header
(8 to 100 URL-safe characters). The contract requires `idempotency: "required"`
for any operation that creates, so the key is mandatory (`400
idempotency_key_required`). A repeat of the same key and body returns the
first answer with `replayed: true`; the same key with a different body is `409
runtime_idempotency_conflict`.

Checks, in order: grant (`tbag_`) and operation; body shape; key; `arguments`
at most 12 KiB (`413 arguments_too_large`; the whole body is capped at 16 KiB).
Then the consent must exist, be active-for-this-caller, and belong to this
agent, workspace and deployment, else `404 consent_not_found` (the same answer
for an unknown and a foreign id, so ids do not leak). A wrong `toolkit`, a
wrong `action` or a revoked consent is `403 consent_mismatch` with a `reason`.

The call then runs through the same code as the Portal runtime receiver
(`/api/marketplace/v1/runtime/composio/execute`): connection, capability
binding, published action, Rules or owner approval, idempotent dispatch, usage
ledger and audit. Only the proof of the consent differs (a Portal lease there,
a Portal app grant here). The provider result is untrusted data: the answer is
JSON with `resultTrust: "untrusted-provider-data"`, credential-like keys are
redacted, the result is capped at 64 KiB, and the response carries
`x-content-type-options: nosniff` and a `default-src 'none'` policy.

## Control endpoints

`GET /healthz` (`{ok, app, version, major, ...}`), and under
`/.well-known/tealbrick/`: `manifest`, `status`, `settings`, `companions`,
`claim` (also at `/api/tealbrick/claim`, same identity) and `guidance/1`.
`status`, `settings` and `companions` accept the Portal-held instance
credential (`Authorization: Bearer`, `x-knowledge-instance-token` or
`x-tealbrick-instance-proof`). `status` and `settings` also accept the 5-minute
settings bearer from a Portal launch, or a live emergency session.

Settings: `composio.baseUrl` and `composio.defaultUserId` are written here
(`composio.baseUrl` must be an `https://*.composio.dev` address). The Composio
key (`composio.apiKey`) is account-sourced and arrives as `COMPOSIO_API_KEY`;
it is reported as presence only.

## Grants

Two agent paths, side by side:

* Portal runtime lease on `/api/marketplace/v1/runtime/composio/execute`.
* Portal app grant (`Authorization: Bearer tbag_...`, contract L1, wire
  `app-grant-v1`) on the two agent operations. It needs the Portal issuer,
  deployment id and instance proof; without them the answer is `503
  portal_unconfigured`.

## Launch and emergency access

`POST /auth/launch` keeps its behaviour and also accepts `route` (one of the
manifest routes, checked before the ticket is spent) and `purpose=settings`
(Portal's server-side settings relay: a 5-minute settings bearer only, no
session). A launch into `/?view=settings` also hands the bearer over in the URL
fragment.

If `TEALBRICK_EMERGENCY_CODE` is set (at least 128 bits), `POST /auth/emergency`
signs the owner in for 15 minutes without Portal, rate-limited per client
(`X-Forwarded-For`, one trusted proxy) and audited without the code. The UI
shows a banner. Rotate by changing the variable and redeploying.

## Configuration

`TEALBRICK_TENANT_ID` must equal `MARKETPLACE_ORGANIZATION_ID` (or
`MARKETPLACE_PORTAL_WORKSPACE_ID`); a mismatch stops start-up. It is the
binding when neither of the others is set. `TEALBRICK_PORTAL_URL`,
`TEALBRICK_DEPLOYMENT_ID`, `TEALBRICK_PORTAL_ORG_ID` and
`TEALBRICK_PORTAL_INSTANCE_PROOF` are accepted beside the `MARKETPLACE_PORTAL_*`
names (a conflict stops start-up). `TEALBRICK_INSTANCE_TOKEN` is accepted
beside `MARKETPLACE_INTERNAL_AUTH_TOKEN` as an instance credential.

## Rules companion

Rules is an optional companion (`enhanced-by`). `GET .../companions` reports
it bound only when `RULES_BASE_URL` and `RULES_INTERNAL_AUTH_TOKEN` are set.
Without Rules, Marketplace stays in owner approval mode.
