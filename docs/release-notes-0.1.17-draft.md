# Marketplace 0.1.17 release notes (draft)

Draft only. This file does not cut a release; the version files, release
bundle and manifests change in the release commit.

## Added

* Teal Brick instance claim: `GET` and `POST /api/tealbrick/claim` let Portal
  register a Portal-provisioned Marketplace as a verified runtime app, using the
  same mechanism as Knowledge. See `docs/instance-claim.md`.
  * Authenticated only by the Portal-held deployment credential (internal
    bearer, `x-knowledge-instance-token`, or `x-tealbrick-instance-proof`),
    compared in constant time. Browser sessions, cookies and origins are
    refused.
  * Signs a five minute `tealbrick-app-claim` JWT (EdDSA) only for the
    configured Portal issuer and the configured workspace binding.
  * The Ed25519 identity is created once in
    `instance-claim-identity.json` beside the SQLite database (mode `0600`) and
    is stable across restarts and upgrades.

## Upgrade and rollback

* No schema change and no new required environment variable.
* The first start of 0.1.17 creates `instance-claim-identity.json` in the data
  directory. Back it up with the database; do not delete it during an upgrade.
* Rollback to 0.1.16 needs no data change. The extra file is ignored.
