import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, clearOwnerKey, connectPlugin, getBootstrap, getOwnerKey, setOwnerKey, getCardDetail, getCardSummaries, getOperatorSession, logoutOperator, saveProviderSettings, unlockOperator, unlockWithEmergencyCode } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("frontend API client", () => {
  it("builds bounded summary and encoded detail URLs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }));
    await getCardSummaries({ workspaceSlug: "team one", search: "mail & files", source: "composio", installed: true, offset: 60, limit: 60 });
    await getCardDetail("composio/foo bar", "team one");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/marketplace/cards/summary?workspaceSlug=team+one&search=mail+%26+files&source=composio&installed=true&offset=60&limit=60");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/marketplace/cards/composio%2Ffoo%20bar?workspaceSlug=team%20one");
  });

  it("sends the connect-mode filter only when one is chosen", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }));
    await getCardSummaries({ workspaceSlug: "w", search: "", source: "all", installed: false, offset: 0, limit: 60, connectMode: "needs_auth_config" });
    await getCardSummaries({ workspaceSlug: "w", search: "", source: "all", installed: false, offset: 0, limit: 60, connectMode: "all" });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0]), "http://x").searchParams.get("connectMode")).toBe("needs_auth_config");
    expect(new URL(String(fetchMock.mock.calls[1]?.[0]), "http://x").searchParams.has("connectMode")).toBe(false);
  });

  it("sends an auth config ID with Connect only when one is entered", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await connectPlugin("composio-github", "w", "github", "  ac_github  ");
    await connectPlugin("composio-github", "w", "github", "   ");
    await connectPlugin("composio-github", "w", "github");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ workspaceSlug: "w", actorId: "operator", provider: "github", backend: "composio", authConfigId: "ac_github" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).not.toHaveProperty("authConfigId");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).not.toHaveProperty("authConfigId");
  });

  it("falls back to a truthful bootstrap only when an older Program returns 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing", { status: 404, statusText: "Not Found" }));
    const result = await getBootstrap();
    expect(result.authorization).toMatchObject({ credentialExposedToBrowser: false, hubRoutesRequireBearer: true });
  });

  it("preserves non-404 bootstrap failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "offline" }), { status: 503 }));
    await expect(getBootstrap()).rejects.toBeInstanceOf(ApiError);
  });

  it("keeps the operator credential in an HttpOnly session and adds CSRF only to writes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ session: { configured: true, authenticated: true, mode: "session", principal: { kind: "operator", id: "operator", organizationId: "verified-org" }, csrfToken: "csrf-proof", expiresAt: "2026-08-28T12:00:00.000Z" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await unlockOperator("operator-access-token");
    await saveProviderSettings({
      composioBaseUrl: "https://backend.composio.dev/api/v3.1",
      composioDefaultUserId: "verified-org",
      composioDefaultConnectedAccountId: "",
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "include", method: "POST" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ credentials: "include", method: "PUT" });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("x-csrf-token")).toBe("csrf-proof");
  });

  it("signs in with the break-glass emergency code over JSON and signs out through the emergency route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokenType: "Bearer" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "emergency_code_invalid" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await unlockWithEmergencyCode("the-emergency-code");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/auth/emergency");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "include", body: JSON.stringify({ code: "the-emergency-code" }) });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("accept")).toBe("application/json");
    await expect(unlockWithEmergencyCode("wrong")).rejects.toMatchObject({ status: 401, message: "The emergency code is not valid." });
    await expect(unlockWithEmergencyCode("wrong")).rejects.toMatchObject({ status: 429 });
    await logoutOperator("emergency");
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/auth/emergency/logout");
  });

  it("signals an expired authenticated session on a protected 401", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ session: { configured: true, authenticated: true, mode: "session", principal: { kind: "operator", id: "operator", organizationId: "verified-org" }, csrfToken: "csrf-proof", expiresAt: "2026-08-28T12:00:00.000Z" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "marketplace_unauthorized" }), { status: 401 }));
    await getOperatorSession();
    const expired = vi.fn();
    window.addEventListener("marketplace-auth-expired", expired, { once: true });
    await expect(getCardSummaries({ workspaceSlug: "verified-org", search: "", source: "all", installed: false, offset: 0, limit: 60 })).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("reads, sets and clears the owner Buzz key on the owner-only route with the session CSRF token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url) === "/api/marketplace/auth/session"
        ? new Response(JSON.stringify({ session: { csrfToken: "csrf-owner" } }), { status: 200 })
        : new Response(JSON.stringify({ ok: true, ownerKey: { fingerprint: "0123456789abcdef" } }), { status: 200 }),
    );
    await getOperatorSession();
    await getOwnerKey();
    await setOwnerKey("npub1example");
    await clearOwnerKey();
    const calls = fetchMock.mock.calls.slice(1).map(([url, init]) => ({ url: String(url), method: init?.method ?? "GET", csrf: (init?.headers as Record<string, string> | undefined)?.["x-csrf-token"] ?? null, body: init?.body ?? null }));
    expect(calls).toEqual([
      { url: "/api/marketplace/approvals/owner-key", method: "GET", csrf: null, body: null },
      { url: "/api/marketplace/approvals/owner-key", method: "PUT", csrf: "csrf-owner", body: JSON.stringify({ pubkey: "npub1example" }) },
      { url: "/api/marketplace/approvals/owner-key", method: "DELETE", csrf: "csrf-owner", body: null },
    ]);
  });
});
