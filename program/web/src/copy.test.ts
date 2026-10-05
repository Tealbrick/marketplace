import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { APPROVAL_STATUS_COPY, approvalStatus, errorCopy, knownVersion, refreshErrorCopy, SESSION_ENDED_COPY, shortScope, statusLabel, words } from "./copy";

const apiError = (status: number, body: unknown, message = "raw server detail with MARKETPLACE_INTERNAL_AUTH_TOKEN") => new ApiError(message, status, body);

describe("customer-safe copy", () => {
  it("humanizes snake, kebab, and camelCase identifiers", () => {
    expect(words("rules_review_required")).toBe("Rules Review Required");
    expect(words("hub-auth-required")).toBe("Hub Auth Required");
    expect(words("authRequired")).toBe("Auth Required");
    expect(words("CatalogOnly")).toBe("Catalog Only");
    expect(words("activepieces")).toBe("Activepieces");
  });

  it("labels catalog-only and other statuses in plain language", () => {
    expect(statusLabel("catalogOnly")).toBe("Listed — not yet installable");
    expect(statusLabel("CatalogOnly")).toBe("Listed — not yet installable");
    expect(statusLabel("authRequired")).toBe("Sign-in required");
    expect(statusLabel("someNewState")).toBe("Some New State");
  });

  it("distinguishes Rules outcomes from each other", () => {
    expect(errorCopy(apiError(503, { error: "rules_unavailable" })).title).toBe("Approvals are unavailable right now");
    expect(errorCopy(apiError(403, { error: "rules_denied" })).title).toBe("Your organization's rules don't allow this");
    expect(errorCopy(apiError(409, { error: "rules_review_required" })).title).toBe("This change needs approval");
  });

  it("explains owner approval mode and Portal consent without blaming unavailable approvals", () => {
    expect(approvalStatus({ rules: "not-connected", governance: "owner" })).toBe("owner");
    expect(approvalStatus({ rules: "unavailable", governance: "rules" })).toBe("unavailable");
    expect(approvalStatus({ rules: "connected" })).toBe("connected");
    expect(approvalStatus(undefined)).toBeUndefined();
    expect(APPROVAL_STATUS_COPY.owner.label).toBe("Rules not connected — owner approval mode");
    expect(APPROVAL_STATUS_COPY.owner.detail).toBe("You approve installs and actions yourself. Agents can only act with consent you grant in Teal Brick Portal.");
    expect(APPROVAL_STATUS_COPY.owner.detail).not.toMatch(/can't|unavailable|blocked/iu);
    const consent = errorCopy(apiError(403, { error: "owner_approval_requires_portal_consent" }));
    expect(consent.title).toBe("This needs consent from Teal Brick Portal");
    expect(consent.reference).toBe("owner_approval_requires_portal_consent");
  });

  it("does not report CSRF, Origin, or tenant failures as Rules denials", () => {
    for (const code of ["marketplace_csrf_denied", "marketplace_origin_denied", "portal_launch_origin_denied"]) {
      const copy = errorCopy(apiError(403, { error: code }));
      expect(copy.title).toBe("Security check failed");
      expect(copy.detail).not.toMatch(/rules/iu);
    }
    expect(errorCopy(apiError(403, { error: "agent_grant_tenant_mismatch" })).title).toBe("This belongs to a different organization");
    expect(errorCopy(apiError(403, { error: "something_else" })).title).toBe("You don't have access to this");
  });

  it("tells the user to relaunch from Portal when the session ends", () => {
    const copy = errorCopy(apiError(401, { error: "marketplace_unauthorized" }));
    expect(copy.detail).toBe(SESSION_ENDED_COPY);
    expect(copy.sessionEnded).toBe(true);
    expect(SESSION_ENDED_COPY).toBe("Your session ended — relaunch Marketplace from Teal Brick Portal.");
  });

  it("never echoes raw server detail", () => {
    for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
      const copy = errorCopy(apiError(status, { error: "x", detail: "secret" }));
      expect(`${copy.title} ${copy.detail}`).not.toContain("MARKETPLACE_INTERNAL_AUTH_TOKEN");
      expect(`${copy.title} ${copy.detail}`).not.toContain("secret");
    }
    expect(errorCopy(new Error("boom stack")).detail).not.toContain("boom");
  });

  it("keeps a support reference code", () => {
    expect(errorCopy(apiError(403, { error: "marketplace_csrf_denied" })).reference).toBe("marketplace_csrf_denied");
    expect(errorCopy(apiError(500, "plain text")).reference).toBe("http_500");
  });
});

describe("Composio key copy", () => {
  it("maps key validation and test outcomes to clear copy", () => {
    expect(errorCopy(new ApiError("", 400, { error: "validation_failed", issues: [{ path: ["settings", "composioApiKey"] }] })).title).toBe("That API key doesn't look right");
    expect(errorCopy(new ApiError("", 400, { error: "validation_failed", issues: [{ path: ["settings", "composioBaseUrl"] }] })).title).toBe("That API address isn't allowed");
    expect(errorCopy(new ApiError("", 422, { error: "composio_key_rejected" })).title).toBe("Composio didn't accept this key");
    expect(errorCopy(new ApiError("", 502, { error: "composio_unreachable" })).title).toBe("Couldn't reach Composio");
    expect(errorCopy(new ApiError("", 409, { error: "composio_key_managed_by_environment" })).title).toBe("This key is managed by your deployment");
  });
});

describe("custom connector copy", () => {
  it("maps every custom MCP code to specific, secret-free copy", () => {
    const codes = [
      "custom_mcp_transport_not_allowed",
      "custom_mcp_url_not_allowed",
      "custom_mcp_header_invalid",
      "custom_mcp_header_conflict",
      "custom_mcp_header_limit",
      "custom_mcp_already_exists",
      "custom_mcp_refresh_required",
      "connector_secret_store_unavailable",
      "mcp_unreachable",
      "mcp_timeout",
      "mcp_auth_rejected",
      "mcp_http_error",
      "mcp_protocol_error",
      "mcp_rpc_error",
      "mcp_response_too_large",
      "mcp_tool_failed",
    ];
    const generic = new Set(["Check the details and try again", "A required service is unavailable", "Something went wrong", "Something changed in the meantime"]);
    for (const code of codes) {
      const copy = errorCopy(new ApiError("raw detail", 502, { error: code, detail: "x-api-key: sk-123" }));
      expect(generic.has(copy.title), code).toBe(false);
      expect(copy.reference).toBe(code);
      expect(`${copy.title} ${copy.detail}`).not.toContain("sk-123");
    }
    expect(refreshErrorCopy("mcp_auth_rejected").title).toBe("The MCP server didn't accept the credentials");
    expect(errorCopy(new ApiError("", 403, { error: "workspace_mismatch" })).title).toBe("This belongs to a different organization");
  });
});

describe("agent action catalog copy", () => {
  it("explains catalog selection failures without exposing codes as titles", () => {
    expect(errorCopy(new ApiError("", 404, { error: "agent_action_not_published" })).title).toBe("This action isn't available to agents right now");
    expect(errorCopy(new ApiError("", 409, { error: "agent_action_account_mismatch" })).title).toBe("That account is no longer connected");
    expect(errorCopy(new ApiError("", 409, { error: "agent_action_capability_mismatch" })).title).toBe("This action changed in the meantime");
    expect(errorCopy(new ApiError("", 409, { error: "portal_consent_scope_unavailable" })).title).toBe("This access can't be granted anymore");
    expect(errorCopy(new ApiError("", 403, { error: "agent_action_catalog_tenant_mismatch" })).title).toBe("This belongs to a different organization");
  });
});

describe("customer-safe identifiers", () => {
  it("hides all-zero placeholder versions", () => {
    expect(knownVersion("00000000_00")).toBe(false);
    expect(knownVersion("0.0.0")).toBe(false);
    expect(knownVersion("")).toBe(false);
    expect(knownVersion(null)).toBe(false);
    expect(knownVersion("0.1.0")).toBe(true);
    expect(knownVersion("20260105_01")).toBe(true);
  });

  it("shortens opaque workspace UUIDs but keeps readable scopes", () => {
    expect(shortScope("3f32db87-6f74-4ecf-b7b8-8c72c54f30a3")).toBe("3f32db87…");
    expect(shortScope("default")).toBe("default");
    expect(shortScope("polygonface-studio-workspace")).toBe("polygonface-studio-workspace");
  });
});

