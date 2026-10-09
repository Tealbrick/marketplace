# Marketplace 0.1.19 release notes (draft)

Draft only. This file does not cut a release; the version files, release
bundle and manifests change in the release commit.

## Added

* Connect modes. Every catalog card carries a server-derived `connectMode`
  (`connected`, `no_auth`, `ready_auth_config`, `ready_managed`,
  `ready_user_key`, `needs_auth_config`, `needs_credentials`, `not_supported`).
  The catalog shows a badge per card, a status filter and per-status counts
  (`connectModeCounts`, `?connectMode=` on `/api/marketplace/cards/summary`).
  See `docs/composio-connect-modes.md`.
* The Connect dialog has an optional "Auth config ID" field (under Advanced;
  shown open for `needs_auth_config` cards) that sends `authConfigId`.
* The Composio catalog sync records which toolkits have an enabled custom auth
  config (ids and schemes only, never credentials).

## Fixed

* Connect could never use a custom auth config the owner created in the
  Composio dashboard (for example an OAUTH2 app for a toolkit without
  Composio-managed auth): it failed with "requires custom … configuration"
  before looking up existing configs. Connect now looks up existing configs
  first: passed `authConfigId`, existing custom config, existing managed
  config, then create, then the same error.
* A passed `authConfigId` is now checked: unknown, disabled, or another
  toolkit's config is refused with `400` (`composio_auth_config_not_found`,
  `composio_auth_config_disabled`, `composio_auth_config_toolkit_mismatch`).
  Before, any id was sent to Composio unchecked.
* Auth-config failures on Connect return typed errors
  (`409 composio_auth_config_required`, `409 composio_toolkit_no_auth`,
  `502 composio_auth_config_lookup_failed`) instead of a generic `500`.

## Unchanged

* Connection states, the OAuth callback, execution, Rules gating and the
  instance claim. No new environment variables.
