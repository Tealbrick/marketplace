# Teal Brick instance claim

Marketplace can prove to Portal that Portal controls a Portal-provisioned
Marketplace, so Portal can register it as a verified runtime app. This is the
same mechanism Knowledge uses. It is operator-only proof of app control. It is
never an entitlement, a grant, or agent authorization.

## Routes

Marketplace serves two claim protocols. Both are server-to-server only, accept
the same credentials (see Authentication) and use the same identity: the same
`instanceId` and the same Ed25519 key (see Key storage). Portal Core keeps an
existing runtime registration only when `instanceId` and `publicJwk` are
identical on both paths, and they always are.

| Path | Protocol | Use |
| --- | --- | --- |
| `/.well-known/tealbrick/claim` | Manifest claim (`tealbrick.miniapp/v1`, `runtime.claim`), served by the `@tealbrick/contract` claim handler | Portal Core claims Marketplace >= 0.2.0 here, with grant trust anchors. |
| `/api/tealbrick/claim` | Legacy Marketplace claim | Unchanged for the 0.2.x line. |

Before 0.2.0 the well-known path was an alias of the legacy route. The two
protocols differ in the `POST` body and answer, so the well-known path now
speaks only the manifest protocol and the legacy protocol stays on
`/api/tealbrick/claim`. A legacy challenge `{portalIssuer, nonce, companyId}`
sent to the well-known path is still a valid manifest challenge; the answer is
`{proof}` only.

### Manifest claim: `/.well-known/tealbrick/claim`

* `GET` returns exactly `{instanceId, publicJwk}`. `publicJwk` is
  `{kty: "OKP", crv: "Ed25519", x}`.
* `POST` takes `{portalIssuer, nonce, companyId}` plus the optional grant trust
  anchors `jwksUri` and `grantKids`, and returns exactly `{proof}`.
  * `jwksUri` must be on the `portalIssuer` origin (HTTPS, no credentials, no
    fragment). `grantKids` is 1 to 16 unique kids and needs `jwksUri`.
  * `companyId` must equal this instance's workspace binding (below).
    Otherwise `409 tenant_mismatch`.
  * `portalIssuer` must equal the configured Portal issuer. Otherwise
    `403 issuer_not_allowed`.
  * Any other key, a bad nonce or a bad issuer gives `400 invalid_claim_request`.
  * A retry with the same nonce and body returns the same proof (idempotent).
  * The first successful claim pins the issuer, the company and the instance id.
    A later claim for another issuer or company gets
    `409 claim_rebinding_refused` until the operator removes the binding file.
  * Without a configured issuer or workspace binding, `POST` answers
    `503 claim_scope_unconfigured` (after authentication); `GET` still works.
* Refusals use the contract kit codes: `401 unauthorized` without a valid
  credential, `403 service_request_required` with a browser `Origin` or
  `Cookie`.

The anchors are stored durably (see Key storage). A claim without anchors keeps
the stored ones. When Portal sends them, the stored binding is the input for
L2 app-grant verification (`l2GrantOptionsFromClaim`): the pinned issuer, its
`jwksUri`, the grant kids and `aud` = this `instanceId`.

### Legacy claim: `/api/tealbrick/claim`

* `GET /api/tealbrick/claim` returns `{instanceId, publicJwk}`.
* `POST /api/tealbrick/claim` takes exactly `{portalIssuer, nonce, companyId}`
  and returns `{proof, publicJwk, instanceId, companyId}`. It does not accept
  or store anchors.

### Authentication

Both paths apply one credential rule (one function in `app.ts`; the manifest
handler gets it as its custom credential verifier). A request must present one
Portal-held deployment credential:

* `Authorization: Bearer <MARKETPLACE_INTERNAL_AUTH_TOKEN>`, or the same value
  in `x-knowledge-instance-token` (Portal Core sends this header, not Bearer);
* `TEALBRICK_INSTANCE_TOKEN` in the same two headers; or
* `x-tealbrick-instance-proof: <Portal instance proof>`.

Comparison is constant time. A missing or wrong credential gets `401`. Any
request that carries a browser `Origin` or a `Cookie` header gets `403`, even
with a valid credential, so an operator session can never sign a claim. Without
a configured credential the routes are not reachable. Responses are
`cache-control: no-store`.

### Challenge rules (legacy path)

* `portalIssuer` must be a canonical origin (HTTPS; loopback HTTP is allowed for
  fixtures) and must equal the configured Portal issuer URL
  (`MARKETPLACE_PORTAL_ISSUER_URL`, `MARKETPLACE_PORTAL_URL` or
  `MARKETPLACE_PORTAL_ORIGIN`). Otherwise `403 claim_issuer_mismatch`.
* `companyId` must equal this instance's workspace binding, which is
  `MARKETPLACE_ORGANIZATION_ID` (or `MARKETPLACE_PORTAL_WORKSPACE_ID` when the
  organization is not set). Otherwise `403 claim_scope_unknown`. If no issuer or
  no binding is configured the route answers `503 claim_scope_unconfigured`; it
  never invents a default company.
* `nonce` is 16 to 256 base64url characters. Extra or missing fields give
  `400 invalid_claim_challenge`.

### Proof format

`proof` is a compact JWT. The header is exactly `{"alg":"EdDSA","typ":"JWT"}`.
The payload has exactly these keys:

```json
{
  "typ": "tealbrick-app-claim",
  "version": 1,
  "aud": "https://portal.example",
  "nonce": "<challenge nonce>",
  "instanceId": "<persistent UUID>",
  "companyId": "<workspace>",
  "iat": 0,
  "exp": 300
}
```

`iat` is the current Unix time in seconds and `exp` is `iat + 300`. Portal must
verify the signature with the key from `GET`, plus nonce, audience, company,
instance and expiry, and must use each challenge once.

## Key storage

The Ed25519 private key and the instance id are generated once and stored in
`instance-claim-identity.json` next to the SQLite database (`/data/state` in the
Railway image), mode `0600`, so they have the same durability as other
Marketplace state. They are never regenerated on restart or upgrade and the
private key is never logged or returned. Unsafe permissions or a malformed file
stop startup instead of replacing the identity. Back this file up with the
database. If it is lost, Portal must revoke and re-register the app, because the
instance id and key change.

Both claim paths read this one file through one `MarketplaceInstanceClaim`
object. The manifest handler gets the same in-memory key from it
(`claimSigningKey()`) and the kit checks that the key matches the served
`publicJwk`. No code path writes a second key. An upgrade from a release before
0.2.0 keeps the file byte for byte.

The manifest claim binding (pinned issuer, company, instance id, claim times,
`jwksUri`, `grantKids`) is stored in `instance-claim-binding.json` beside the
identity, mode `0600`, replaced atomically. It holds no secret and no key.
Unsafe permissions or a malformed file make the manifest `POST` fail closed
(`500`); the file is never replaced silently. To move the instance to another
Portal issuer or workspace, remove this file (the identity stays).
