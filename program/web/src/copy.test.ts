import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { errorCopy, SESSION_ENDED_COPY, statusLabel, words } from "./copy";

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
