# Marketplace 0.1.18 release notes (draft)

Draft only. This file does not cut a release; the version files, release
bundle and manifests change in the release commit.

## Changed

* The Teal Brick instance claim is now served at the canonical
  `/.well-known/tealbrick/claim` (`GET` and `POST`). `/api/tealbrick/claim`
  remains a working alias served by the same handlers, with the same
  authentication (Portal-held deployment credential only; anonymous `401`,
  browser cookie or origin `403`), the same responses and the same identity. See
  `docs/instance-claim.md`.

## Upgrade and rollback

* No schema change, no new environment variable and no new data file.
* Rollback to 0.1.17 needs no data change; only the alias path is served then.
