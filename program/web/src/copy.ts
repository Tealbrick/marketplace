import { ApiError } from "./api";
import type { ConnectMode, GovernanceMode, RulesConnectionStatus } from "./types";

export type ErrorCopy = {
  title: string;
  detail: string;
  /** Machine code for support conversations; never the raw server message. */
  reference: string | null;
  /** True when the browser session is gone and the user must relaunch from Portal. */
  sessionEnded?: boolean;
};

export const SESSION_ENDED_COPY = "Your session ended — relaunch Marketplace from Teal Brick Portal.";

/** Bot tokens are entered only in Portal (spec §8); Marketplace never shows a token field. */
export const CHANNEL_TOKEN_HINT = "Add the bot token under Account Connections in Teal Brick Portal. Marketplace never asks for the token here.";

export const TELEGRAM_DISCOVER_HINT = "Add the bot to the chat and send one message, then press Discover.";

export const DISCORD_DISCOVER_HINT = "Invite the bot to your server with View Channels, Send Messages, Attach Files and Embed Links, then press Discover.";

export const UNCERTAIN_RESOLVE_HINT = "The provider may have posted this. Open the destination and look for the post first. Mark it sent only if you can see it. Mark it failed only if it isn't there: that lets the agent post it again.";

const STATUS_LABELS: Record<string, string> = {
  catalogOnly: "Listed — not yet installable",
  authRequired: "Sign-in required",
  ready: "Ready",
  installed: "Installed",
  available: "Available",
  disabled: "Removed",
  disconnected: "Not connected",
  connected: "Connected",
  pending: "Pending",
  expired: "Expired",
  revoked: "Revoked",
  denied: "Denied",
};

/**
 * Turn identifiers such as `snake_case`, `kebab-case`, or `camelCase` into
 * readable Title Case words.
 */
export function words(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}

/** Customer-facing label for a lifecycle or connection status. */
export function statusLabel(value: string) {
  const key = value.charAt(0).toLowerCase() + value.slice(1);
  return STATUS_LABELS[key] ?? words(value);
}

/** Badge labels for connect modes, in the order the status filter shows them. */
export const CONNECT_MODE_LABELS: Record<ConnectMode, string> = {
  connected: "Connected",
  ready_managed: "Ready to connect",
  ready_user_key: "Ready — needs your API key",
  ready_auth_config: "Ready — uses your auth config",
  no_auth: "No sign-in needed",
  needs_auth_config: "Needs an auth config",
  needs_credentials: "Needs credentials",
  not_supported: "Can't connect yet",
};

export const CONNECT_MODE_ORDER = Object.keys(CONNECT_MODE_LABELS) as ConnectMode[];

export function connectModeLabel(mode: ConnectMode | undefined) {
  return mode ? CONNECT_MODE_LABELS[mode] ?? words(mode) : null;
}

export function connectModeTone(mode: ConnectMode | undefined): "success" | "warning" | "accent" | "danger" | "default" {
  switch (mode) {
    case "connected":
      return "success";
    case "ready_managed":
    case "ready_user_key":
    case "ready_auth_config":
    case "no_auth":
      return "accent";
    case "needs_auth_config":
    case "needs_credentials":
      return "warning";
    default:
      return "default";
  }
}

/** One plain sentence on what connecting this connector involves. */
export function connectModeHint(mode: ConnectMode | undefined, toolkit?: string | null) {
  switch (mode) {
    case "connected":
      return "This connector is connected for your workspace.";
    case "ready_managed":
      return "Connect opens the provider's sign-in page through Composio.";
    case "ready_user_key":
      return "Connect opens a Composio page where you enter your API key for this service.";
    case "ready_auth_config":
      return "Connect uses the auth config you created for this toolkit in Composio.";
    case "no_auth":
      return "This service does not need a sign-in.";
    case "needs_auth_config":
      return `Composio does not manage sign-in for this service. In your Composio dashboard, create an auth config for ${toolkit ? `the "${toolkit}" toolkit` : "this toolkit"}, then choose Connect and paste its ID.`;
    case "needs_credentials":
      return "Add this connector's address and credentials, then test or refresh it under Connections.";
    case "not_supported":
      return "Marketplace can't connect this listing yet.";
    default:
      return null;
  }
}

export const CATALOG_ONLY_HINT = "Only Composio connectors and your own custom connectors can be installed today. This listing is shown for reference.";

export const CUSTOM_CONNECTOR_TOOLS_HINT = "Load this connector's tools first: open Connections, find it under Custom connectors, and choose Refresh tools.";

export function errorCodeOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const code = (body as Record<string, unknown>).error;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return null;
}

function validationField(error: unknown) {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { issues?: Array<{ path?: unknown[] }> } | null;
  const path = body?.issues?.[0]?.path;
  return Array.isArray(path) ? path.map(String).join(".") : null;
}

function isSecurityCheckCode(code: string) {
  return /(^|_)(origin|csrf)(_|$)/u.test(code) || code.includes("_origin_") || code.endsWith("_service_request_required");
}

function isTenantCode(code: string) {
  return /tenant|organization_mismatch|org_mismatch|workspace_mismatch|scope_mismatch/u.test(code);
}

/**
 * Map an API failure to plain, customer-safe copy. Raw server `detail`
 * strings are never shown: they can contain configuration names, internal
 * routes, or upstream provider messages.
 */
export function errorCopy(error: Error): ErrorCopy {
  const status = error instanceof ApiError ? error.status : 0;
  const code = errorCodeOf(error);
  const reference = code ?? (status ? `http_${status}` : null);

  switch (code) {
    case "rules_unavailable":
      return { title: "Approvals are unavailable right now", detail: "Marketplace couldn't reach your organization's approval service, so nothing was changed. Try again in a few minutes. If this keeps happening, contact your administrator.", reference };
    case "rules_denied":
      return { title: "Your organization's rules don't allow this", detail: "This change was not approved, so nothing was changed. Ask your administrator if you need access.", reference };
    case "owner_approval_requires_portal_consent":
      return { title: "This needs consent from Teal Brick Portal", detail: "Agents and connected apps can only act with consent you grant in Teal Brick Portal. Nothing was changed.", reference };
    case "rules_review_required":
      return { title: "This change needs approval", detail: "An administrator has to approve this change before it can go ahead. Nothing has been changed yet.", reference };
    case "operator_unauthorized":
      return { title: "That access token wasn't accepted", detail: "Check the token and try again, or relaunch Marketplace from Teal Brick Portal.", reference };
    case "operator_rate_limited":
      return { title: "Too many attempts", detail: "Wait a minute before trying again.", reference };
    case "operator_auth_unconfigured":
    case "marketplace_operator_auth_unconfigured":
      return { title: "Sign-in isn't set up yet", detail: "This Marketplace hasn't been fully set up. Ask your administrator to finish setup, then relaunch from Teal Brick Portal.", reference };
    case "composio_api_key_invalid":
      return { title: "That API key doesn't look right", detail: "Paste the key exactly as Composio shows it, without spaces or line breaks.", reference };
    case "composio_key_rejected":
      return { title: "Composio didn't accept this key", detail: "The key may have been revoked or copied incorrectly. Create a new key in Composio and paste it here.", reference };
    case "composio_key_missing":
      return { title: "No API key saved", detail: "Paste your Composio API key and save it before testing.", reference };
    case "composio_unreachable":
      return { title: "Couldn't reach Composio", detail: "Marketplace couldn't contact Composio to check the key. Try again in a few minutes.", reference };
    case "composio_base_url_not_allowed":
      return { title: "That API address isn't allowed", detail: "Use a Composio address such as https://backend.composio.dev/api/v3.1.", reference };
    case "composio_key_managed_by_environment":
      return { title: "This key is managed by your deployment", detail: "The key was provided when Marketplace was deployed, so it can't be removed here. Ask your administrator to change it.", reference };
    case "custom_mcp_transport_not_allowed":
      return { title: "Local command servers aren't supported here", detail: "Add an MCP server by its https:// address. Servers that run as a local command (stdio) can't be added from the browser.", reference };
    case "custom_mcp_url_not_allowed":
      return { title: "That server address isn't allowed", detail: "Use an https:// address on the public internet or your Tailscale network (*.ts.net). Local, private-network, and cloud metadata addresses are blocked. Put API keys in a secret header, not in the address.", reference };
    case "custom_mcp_header_invalid":
      return { title: "A header isn't valid", detail: "Header names can use letters, numbers, and dashes, and values can't contain line breaks. Headers such as Host or Content-Type are set by Marketplace and can't be changed.", reference };
    case "custom_mcp_header_conflict":
      return { title: "A header is listed twice", detail: "Each header can be either a regular header or a secret, not both.", reference };
    case "custom_mcp_header_limit":
      return { title: "Too many headers", detail: "Use at most 20 regular headers and 10 secret headers.", reference };
    case "custom_mcp_already_exists":
      return { title: "You already have a connector with this name", detail: "Pick a different name, or edit the existing connector.", reference };
    case "composio_auth_config_required":
      return { title: "This service needs an auth config", detail: "Composio does not manage sign-in for this service. Create an auth config for this toolkit in your Composio dashboard, then paste its ID under Advanced and connect again.", reference };
    case "composio_auth_config_toolkit_mismatch":
      return { title: "That auth config is for a different service", detail: "Use the ID of an auth config created for this connector's toolkit in your Composio dashboard.", reference };
    case "composio_auth_config_not_found":
      return { title: "Auth config not found", detail: "Check the ID in your Composio dashboard. It must belong to the same Composio project as the API key in Settings.", reference };
    case "composio_auth_config_disabled":
      return { title: "That auth config is turned off", detail: "Enable it in your Composio dashboard, then connect again.", reference };
    case "composio_auth_config_lookup_failed":
      return { title: "Couldn't check the auth config", detail: "Marketplace couldn't reach Composio to check the auth config. Try again in a few minutes.", reference };
    case "composio_toolkit_no_auth":
      return { title: "This service doesn't need a sign-in", detail: "There is nothing to connect for this service.", reference };
    case "custom_mcp_refresh_required":
      return { title: "Use Refresh tools to connect", detail: "Custom connectors connect when Marketplace loads their tools. Open Connections and choose Refresh tools.", reference };
    case "connector_secret_store_unavailable":
      return { title: "Secrets can't be saved right now", detail: "This Marketplace isn't set up to store secrets securely, so nothing was saved. Ask your administrator to configure secret storage, or add the connector without secret headers.", reference };
    case "mcp_unreachable":
      return { title: "Couldn't reach the MCP server", detail: "Check the server address and that the server is running, then try again.", reference };
    case "mcp_timeout":
      return { title: "The MCP server took too long to respond", detail: "The server may be busy or unreachable. Try again in a moment.", reference };
    case "mcp_auth_rejected":
      return { title: "The MCP server didn't accept the credentials", detail: "Check the secret headers (for example the API key), replace them if needed, and refresh again.", reference };
    case "mcp_http_error":
      return { title: "The MCP server returned an error", detail: "Check that the address points to the server's MCP endpoint, then try again.", reference };
    case "mcp_protocol_error":
    case "mcp_rpc_error":
      return { title: "The server's response wasn't understood", detail: "Make sure the address points to an MCP endpoint and the transport matches what the server supports.", reference };
    case "mcp_response_too_large":
      return { title: "The MCP server's response was too large", detail: "Marketplace accepts responses up to 2 MB. Ask the server owner to reduce the response size.", reference };
    case "mcp_tool_failed":
      return { title: "The tool reported an error", detail: "The MCP server ran the tool but it failed. Check the arguments and try again.", reference };
    case "company_box_base_url_not_allowed":
      return { title: "That app address isn't allowed", detail: "Use the app's https:// address on your tailnet (*.ts.net) or the public internet. Local, private-network and cloud metadata addresses are blocked, and keys don't belong in the address.", reference };
    case "company_box_credentials_required":
      return { title: "Credentials are missing", detail: "Fill in every credential field when you first set up an app or move it to a new address. Saved credentials are never sent to a different host.", reference };
    case "company_box_credential_unknown":
    case "company_box_credential_invalid":
      return { title: "A credential isn't valid", detail: "Paste the value exactly as the app shows it, without line breaks.", reference };
    case "company_box_entry_unavailable":
      return { title: "This app's catalog entry is broken", detail: "Its pinned spec failed the coverage check, so it can't be set up. Ask your administrator to fix the entry.", reference };
    case "company_box_not_set_up":
      return { title: "Set this app up first", detail: "Add its address and credentials, then test the connection.", reference };
    case "openapi_auth_rejected":
      return { title: "The app didn't accept the credentials", detail: "Check the token or password, replace it, and test again.", reference };
    case "openapi_unreachable":
    case "openapi_timeout":
      return { title: "Couldn't reach the app", detail: "Check the address and that Marketplace can reach your tailnet, then test again.", reference };
    case "openapi_http_error":
      return { title: "The app returned an error", detail: "Check that the address points at the app (not a proxy login page), then test again.", reference };
    case "openapi_response_too_large":
      return { title: "The app's response was too large", detail: "Marketplace accepts responses up to 2 MB.", reference };
    case "openapi_base_url_not_allowed":
      return errorCopy(new ApiError(code, status, { error: "company_box_base_url_not_allowed" }));
    case "tailnet_unavailable":
      return { title: "The tailnet is unavailable", detail: "Marketplace couldn't join your tailnet, so apps on *.ts.net can't be reached. Check the TS_AUTHKEY on the Marketplace service and its logs.", reference };
    case "owner_approval_required_for_outward":
      return { title: "This sends something outside your workspace", detail: "Outward actions such as sending or publishing need your approval each time. Run it yourself from Marketplace, or connect approvals.", reference };
    case "approval_args_too_large":
      return { title: "Too large to hold for approval", detail: "Outward calls are stored in full while they wait for you, up to 32 KB. Send a smaller file, or upload it with a non-outward operation first.", reference };
    case "openapi_upload_too_large":
      return { title: "The file is too large", detail: "Uploads are limited per call (25 MB by default).", reference };
    case "approval_queue_full":
      return { title: "Too many requests are waiting", detail: "This agent already has 50 calls waiting for approval. Approve or deny some first.", reference };
    case "custom_mcp_secrets_required_for_new_origin":
      return { title: "Enter the secrets again for the new address", detail: "Saved secrets stay with the server they were entered for. Replace or remove each secret header when you change the server's address.", reference };
    case "approval_not_pending":
      return { title: "This request was already decided", detail: "Someone approved or denied it, or it ran. Refresh to see what happened.", reference };
    case "approval_expired":
      return { title: "This request expired", detail: "Requests wait 7 days for approval. The agent can ask again.", reference };
    case "approval_not_found":
      return { title: "Request not found", detail: "It may belong to another workspace or was removed. Refresh and try again.", reference };
    case "agent_action_not_published":
      return { title: "This action isn't available to agents right now", detail: "The connector may have been removed or disconnected, or the action was turned off. Refresh and choose an action from the list.", reference };
    case "agent_action_account_mismatch":
      return { title: "That account is no longer connected", detail: "The connector is now linked to a different account. Refresh and choose the connected account from the list.", reference };
    case "agent_action_resource_mismatch":
    case "agent_action_capability_mismatch":
      return { title: "This action changed in the meantime", detail: "Its access level or scope was updated. Refresh and choose the action again.", reference };
    case "portal_consent_scope_unavailable":
      return { title: "This access can't be granted anymore", detail: "The action, account, or access level changed after the request was made, so nothing was granted. Refresh and request access again.", reference };
    case "portal_handoff_denied":
      return { title: "Access was declined in Teal Brick Portal", detail: "The request was denied, so no access was granted. Start a new request if this was a mistake.", reference };
    case "channel_credential_missing":
      return { title: "The bot token isn't added yet", detail: CHANNEL_TOKEN_HINT, reference };
    case "channel_credential_invalid":
      return { title: "The provider didn't accept the bot token", detail: "Replace the bot token under Account Connections in Teal Brick Portal. Marketplace never asks for it here.", reference };
    case "channel_provider_unavailable":
    case "channel_unavailable":
      return { title: "Couldn't reach the provider", detail: "Marketplace couldn't contact the chat provider. Try again in a few minutes.", reference };
    case "channel_consumer_conflict":
      return { title: "Another Marketplace is reading this bot's updates", detail: "Only one Marketplace can read a Telegram bot's updates at a time. Try again in a minute.", reference };
    case "channel_connection_unavailable":
      return { title: "The bot isn't ready", detail: "Check the provider card above. The bot token must be added under Account Connections in Teal Brick Portal and verified.", reference };
    case "channel_destination_not_discovered":
      return { title: "Discover the destination again", detail: "Marketplace remembers discovered destinations for a short time only. Press Discover again and pick the destination from the list.", reference };
    case "channel_policy_invalid":
      return { title: "Check the posting rules", detail: "Some rules are outside what the provider allows. The fields are listed below.", reference };
    case "channel_slug_taken":
      return { title: "This slug is already used", detail: "Each channel needs its own slug. Change the slug and try again.", reference };
    case "channel_revision_conflict":
      return { title: "This channel changed in the meantime", detail: "Someone saved a newer version. Refresh, check the rules again and save.", reference };
    case "channel_archived":
      return { title: "This channel is archived", detail: "Archived channels keep their receipts but can't be changed or used again.", reference };
    case "channel_not_active":
      return { title: "The channel isn't active", detail: "Resume the channel before you send to it or approve grants for it.", reference };
    case "channel_not_found":
      return { title: "Channel not found", detail: "It may have been archived or removed. Refresh and try again.", reference };
    case "channel_send_failed":
      return { title: "The message wasn't delivered", detail: "The provider refused it or couldn't be reached. Nothing was posted.", reference };
    case "channel_send_uncertain":
      return { title: "Delivery is uncertain", detail: "The request left Marketplace but no answer came back. Check the destination, then resolve the post below.", reference };
    case "channel_cap_per_day":
    case "channel_cap_per_hour":
    case "channel_min_interval":
    case "channel_phase_duplicate":
      return { title: "The channel's posting limit is reached", detail: "The channel ceiling counts every post, including tests. Wait, or raise the ceiling in the posting rules.", reference };
    case "channel_outside_window":
      return { title: "Outside the posting window", detail: "This channel only posts inside its schedule window. Try again inside the window, or change it.", reference };
    case "grant_widening_refused":
      return { title: "You can only narrow a proposal", detail: "An approved grant can never allow more than the agent proposed. To allow more, the agent proposes again. The fields that would widen it are listed below.", reference };
    case "grant_exceeds_ceiling":
      return { title: "The grant is above the channel ceiling", detail: "Lower the grant, or raise the channel's posting rules first. The fields over the ceiling are listed below.", reference };
    case "standing_grants_disabled":
      return { title: "Standing grants are off for this channel", detail: "Allow standing grants in the channel's posting rules before you approve one.", reference };
    case "grant_consent_inactive":
      return { title: "The agent's Portal consent ended", detail: "This grant is bound to a consent that is no longer active. Grant the agent access again, then ask it to propose again.", reference };
    case "grant_not_pending":
    case "grant_not_revocable":
    case "grant_changed":
      return { title: "This grant changed in the meantime", detail: "It was decided, withdrawn or changed elsewhere. Refresh to see its current state.", reference };
    case "channel_kind_unsupported":
      return { title: "This provider doesn't serve that kind of channel", detail: "Choose one of the kinds listed for the provider.", reference };
    case "channels_not_configured":
      return { title: "Channels aren't set up yet", detail: CHANNEL_TOKEN_HINT, reference };
    case "channel_post_not_cancellable":
      return { title: "This post can't be cancelled any more", detail: "It was already sent, skipped or ended. Refresh to see its receipt.", reference };
    case "channel_post_not_uncertain":
      return { title: "This post is already resolved", detail: "Refresh to see its current state.", reference };
    case "channel_selection_mismatch":
      return { title: "This channel's connection changed", detail: "The bot connection changed after the page loaded. Refresh and try again.", reference };
    case "portal_session_required":
    case "portal_session_expired":
      return { title: "Open Marketplace from Teal Brick Portal first", detail: "Granting access needs a current Portal launch for this deployment. Relaunch Marketplace from Portal and try again.", reference };
    default:
      break;
  }

  if (status === 401) {
    return { title: "Your session ended", detail: SESSION_ENDED_COPY, reference, sessionEnded: true };
  }
  if (status === 403 && code && isTenantCode(code)) {
    return { title: "This belongs to a different organization", detail: "You can only manage items for the organization you launched Marketplace from. Relaunch from Teal Brick Portal in the right organization.", reference };
  }
  if (status === 403 && code && isSecurityCheckCode(code)) {
    return { title: "Security check failed", detail: "Marketplace couldn't verify this request came from your session. Reload the page and try again; if it keeps happening, relaunch from Teal Brick Portal.", reference };
  }
  if (status === 403) {
    return { title: "You don't have access to this", detail: "Your session can't perform this action. Ask your administrator if you need access.", reference };
  }
  if (status === 400 || status === 422) {
    const field = validationField(error);
    if (field?.includes("composioApiKey")) return errorCopy(new ApiError("", 400, { error: "composio_api_key_invalid" }));
    if (field?.includes("composioBaseUrl")) return errorCopy(new ApiError("", 400, { error: "composio_base_url_not_allowed" }));
    return { title: "Check the details and try again", detail: "Some of the information couldn't be accepted. Review it and try again.", reference };
  }
  if (status === 404) {
    return { title: "Not found", detail: "This item is no longer available. Refresh and try again.", reference };
  }
  if (status === 409) {
    return { title: "Something changed in the meantime", detail: "This item was updated elsewhere. Refresh to see the latest state, then try again.", reference };
  }
  if (status === 429) {
    return { title: "Too many requests", detail: "Wait a moment before trying again.", reference };
  }
  if (status === 502 || status === 503 || status === 504) {
    return { title: "A required service is unavailable", detail: "Marketplace couldn't reach a service it depends on, so nothing was changed. Try again in a few minutes.", reference };
  }
  if (error instanceof SyntaxError) {
    return { title: "Arguments must be valid JSON", detail: "Fix the arguments and try again.", reference: null };
  }
  return { title: "Something went wrong", detail: "Marketplace couldn't complete the request. Try again; if it keeps happening, contact your administrator.", reference };
}

/** Copy for a stored custom connector refresh error code. */
export function refreshErrorCopy(code: string): ErrorCopy {
  return errorCopy(new ApiError(code, 502, { error: code }));
}

/** Approval status shown in the topbar, navigation, and Settings. */
export type ApprovalStatus = RulesConnectionStatus | "owner";

export function approvalStatus(health: { rules?: RulesConnectionStatus; governance?: GovernanceMode } | undefined): ApprovalStatus | undefined {
  if (!health) return undefined;
  return health.governance === "owner" ? "owner" : health.rules;
}

export const OWNER_APPROVAL_DETAIL = "You approve installs and actions yourself. Agents can only act with consent you grant in Teal Brick Portal.";

export const APPROVAL_STATUS_COPY: Record<ApprovalStatus, { label: string; short: string; topbar: string; detail: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  connected: { label: "Connected", short: "connected", topbar: "Approvals connected", detail: "Approvals are working. Changes are checked against your organization's rules.", tone: "success" },
  owner: { label: "Rules not connected — owner approval mode", short: "owner approval mode", topbar: "Rules not connected — owner approval mode", detail: OWNER_APPROVAL_DETAIL, tone: "neutral" },
  "not-connected": { label: "Not set up", short: "not set up", topbar: "Approvals not set up", detail: "The approvals service isn't connected yet.", tone: "warning" },
  unavailable: { label: "Unavailable", short: "unavailable", topbar: "Approvals unavailable", detail: "Marketplace can't reach the approvals service right now. Changes are paused until it's back.", tone: "danger" },
};

/** Long opaque scopes (Portal workspace UUIDs) are shortened; the full id stays in the tooltip. */
export function shortScope(scope: string) {
  return scope.length > 16 && /^[0-9a-f-]+$/iu.test(scope) ? `${scope.slice(0, 8)}…` : scope;
}

/** Catalog imports use all-zero placeholders (e.g. 00000000_00) when no version is published. */
export function knownVersion(version: string | null | undefined) {
  return Boolean(version && !/^[0._-]+$/u.test(version.trim()));
}
