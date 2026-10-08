# Marketplace 0.1.18 release notes (draft)

Draft only. This file does not cut a release; the version files, release
bundle and manifests change in the release commit. That commit also bumps
`app.version` in `tealbrick.app.json` (checked against `program/package.json`
by `hygiene.test.ts`) and rebuilds the bundle, which embeds the manifest.

## Changed

* The Teal Brick instance claim is now served at the canonical
  `/.well-known/tealbrick/claim` (`GET` and `POST`). `/api/tealbrick/claim`
  remains a working alias served by the same handlers, with the same
  authentication (Portal-held deployment credential only; anonymous `401`,
  browser cookie or origin `403`), the same responses and the same identity. See
  `docs/instance-claim.md`.

* Marketplace follows the Teal Brick miniapp contract (`@tealbrick/contract`
  `0.1.0-alpha.3`). `tealbrick.app.json` (kind `suite`) is the manifest, served
  at `/.well-known/tealbrick/manifest`. New control endpoints: `status`,
  `settings`, `companions` and `guidance/1`; `/healthz` also reports `app`,
  `version` and `major`. See `docs/contract.md`.
* Two agent operations over a Portal app grant (`tbag_`): `marketplace.consents.list`
  (the caller's own active consents, no credentials) and `marketplace.tools.call`
  (run one consented action; `Idempotency-Key` required; another agent's or an
  unknown consent is `404`, a wrong toolkit or action is `403 consent_mismatch`).
  `tools.call` shares its execution with the Portal runtime receiver. All other
  operations are owner-only and answer `403 operation_owner_only` to a grant.
* `POST /auth/launch` accepts a validated `route` and Portal's settings relay
  (`purpose=settings`); a launch into the settings route hands over a 5-minute
  settings bearer.
* Break-glass emergency login at `/auth/emergency` when `TEALBRICK_EMERGENCY_CODE`
  is set (audited, rate-limited, banner in the UI).
* `TEALBRICK_TENANT_ID`, `TEALBRICK_INSTANCE_TOKEN` and the `TEALBRICK_PORTAL_*`
  names are accepted beside the existing `MARKETPLACE_*` ones.

## Unchanged

* The instance claim identity and both claim paths, the Portal launch
  hand-off, the runtime lease receiver, the lease and deployment grant
  introspection paths, connector secret encryption and operator sessions.

## Upgrade and rollback

* No schema change and no new data file. The new environment variables are all
  optional (`TEALBRICK_EMERGENCY_CODE`, `TEALBRICK_TENANT_ID`,
  `TEALBRICK_INSTANCE_TOKEN`, `TEALBRICK_PORTAL_*`); the live deployment needs
  none of them. `@tealbrick/contract` is a new runtime dependency (bundled).
* Rollback to 0.1.17 needs no data change; the contract endpoints, agent
  operations and emergency login are simply not served then.
