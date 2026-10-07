# Teal Brick instance claim

Marketplace can prove to Portal that Portal controls a Portal-provisioned
Marketplace, so Portal can register it as a verified runtime app. This is the
same mechanism Knowledge uses. It is operator-only proof of app control. It is
never an entitlement, a grant, or agent authorization.

## Routes

Both routes are server-to-server only.

* `GET /api/tealbrick/claim` returns `{instanceId, publicJwk}`. `publicJwk` is
  an Ed25519 public key with exactly `kty: "OKP"`, `crv: "Ed25519"` and `x`.
* `POST /api/tealbrick/claim` takes exactly `{portalIssuer, nonce, companyId}`
  and returns `{proof, publicJwk, instanceId, companyId}`.

### Authentication

A request must present one Portal-held deployment credential:

* `Authorization: Bearer <MARKETPLACE_INTERNAL_AUTH_TOKEN>`, or the same value
  in `x-knowledge-instance-token`; or
* `x-tealbrick-instance-proof: <Portal instance proof>`.

Comparison is constant time. A missing or wrong credential gets `401`. Any
request that carries a browser `Origin` or a `Cookie` header gets `403`, even
with a valid credential, so an operator session can never sign a claim. Without
a configured credential the routes are not reachable. Responses are
`cache-control: no-store`.

### Challenge rules

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
