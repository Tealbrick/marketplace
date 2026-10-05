import { ApiError } from "./api";

export type ErrorCopy = {
  title: string;
  detail: string;
  /** Machine code for support conversations; never the raw server message. */
  reference: string | null;
  /** True when the browser session is gone and the user must relaunch from Portal. */
  sessionEnded?: boolean;
};

export const SESSION_ENDED_COPY = "Your session ended — relaunch Marketplace from Teal Brick Portal.";

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

export const RULES_STATUS_COPY: Record<"connected" | "not-connected" | "unavailable", { label: string; detail: string; tone: "success" | "warning" | "danger" }> = {
  connected: { label: "Connected", detail: "Approvals are working. Changes are checked against your organization's rules.", tone: "success" },
  "not-connected": { label: "Not set up", detail: "The approvals service isn't connected, so installs and connections can't be approved. Ask your administrator to connect it.", tone: "warning" },
  unavailable: { label: "Unavailable", detail: "Marketplace can't reach the approvals service right now. Changes are paused until it's back.", tone: "danger" },
};

/** Long opaque scopes (Portal workspace UUIDs) are shortened; the full id stays in the tooltip. */
export function shortScope(scope: string) {
  return scope.length > 16 && /^[0-9a-f-]+$/iu.test(scope) ? `${scope.slice(0, 8)}…` : scope;
}

/** Catalog imports use all-zero placeholders (e.g. 00000000_00) when no version is published. */
export function knownVersion(version: string | null | undefined) {
  return Boolean(version && !/^[0._-]+$/u.test(version.trim()));
}
