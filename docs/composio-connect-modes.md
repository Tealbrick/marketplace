# Connector connect modes and Composio auth configs

Marketplace derives one **connect mode** per catalog listing on the server
(`program/src/connect-mode.ts`, `connectMode(listing, connections)`). The cards
API returns it; the browser only displays it.

## Where it appears

* `GET /api/marketplace/cards/summary`: each item has `connectMode`. The
  response has `connectModeCounts` (every mode, after the search, source and
  installed filters, before the mode filter). The optional query parameter
  `connectMode=<mode>` filters the items.
* `GET /api/marketplace/cards` and `GET /api/marketplace/cards/:pluginId`: each
  card has `connectMode`. The detail card also has `connectInfo`
  (`toolkit`, `authSchemes`, `managedAuthSchemes`) for Composio listings.
* The catalog shows a badge per card, a status filter with counts, and a
  note on `needs_auth_config` cards.

## Modes (first match wins)

| Mode | Rule | UI label |
| --- | --- | --- |
| `connected` | the workspace has a `connected` connection for the listing | Connected |
| `needs_credentials` | custom MCP connector (own workspace) or Company Box app, not connected | Needs credentials |
| `not_supported` | any other non-Composio execution backend, or a custom MCP of another workspace | Can't connect yet |
| `no_auth` | Composio `no_auth` toolkit, a `NO_AUTH` scheme, or `composio-bootstrap` | No sign-in needed |
| `ready_auth_config` | a known enabled custom auth config for the toolkit with a supported scheme (catalog sync) | Ready — uses your auth config |
| `ready_managed` | Composio-managed schemes exist, or the toolkit lists no schemes | Ready to connect |
| `ready_user_key` | an `API_KEY`, `BEARER_TOKEN` or `BASIC` scheme; the user enters the key on the Composio link page | Ready — needs your API key |
| `ready_auth_config` | a previous connection for the listing recorded an `authConfigId` | Ready — uses your auth config |
| `needs_auth_config` | only owner-configured schemes (`OAUTH2`, `OAUTH1`, `OAUTH1A`, `DCR_OAUTH`, `S2S_OAUTH2`, `GOOGLE_SERVICE_ACCOUNT`, `SERVICE_ACCOUNT`, `BASIC_WITH_JWT`) | Needs an auth config |
| `not_supported` | only unknown schemes | Can't connect yet |

The catalog sync (every 5 minutes with a Composio key) lists the project's
auth configs once and stores, per toolkit, the id and scheme of each enabled
non-managed config on the listing (`manifest.composio.catalog.customAuthConfigs`).
Credentials in the upstream record are never read into Marketplace. A failed
lookup only means no custom config is known.

## Connect: auth config lookup order

`getOrCreateComposioAuthConfig` (`program/src/provider-health.ts`):

1. A passed `authConfigId` (connect API body, or the Connect dialog's
   "Auth config ID" field). Marketplace fetches it and accepts it only when it
   belongs to the toolkit and is enabled. Otherwise the connect API answers
   `400` with `composio_auth_config_not_found`,
   `composio_auth_config_toolkit_mismatch` or `composio_auth_config_disabled`.
2. An existing enabled custom (non-managed) config for the toolkit whose scheme
   the toolkit supports.
3. An existing enabled Composio-managed config for the toolkit.
4. Create a managed config (managed schemes, or no schemes) or a custom config
   with empty credentials for a user-key scheme.
5. Otherwise `409 composio_auth_config_required` with the same message as
   before ("requires custom … configuration before it can be connected").

A `no_auth` toolkit still answers `409 composio_toolkit_no_auth` on Connect.

## Owner steps for a `needs_auth_config` connector

1. In the Composio dashboard, create an auth config for the toolkit shown on
   the card (for example your own OAuth app for `github`).
2. In Marketplace, install the connector and choose Connect.
3. Paste the auth config ID and start the connection.

After the next catalog sync the card shows "Ready — uses your auth config",
and Connect finds the config without the ID.
