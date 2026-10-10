import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, setupCompanyBoxEntry } from "./api";
import { ApprovalFiles, CompanyBoxSection, coverageLabel, exposureLabel } from "./CompanyBox";
import { errorCopy } from "./copy";
import type { CompanyBoxEntry, CompanyBoxResponse } from "./types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SECRET = "typed-secret-value-123";

function entry(overrides: Partial<CompanyBoxEntry> = {}): CompanyBoxEntry {
  return {
    id: "notes",
    displayName: "Notes",
    description: "Team notes.",
    category: null,
    source: "openapi",
    appVersion: "2.4.0",
    homepage: null,
    baseUrlExample: "https://notes.your-tailnet.ts.net",
    auth: { type: "header", fields: [{ key: "token", label: "API token", secret: true }] },
    coverage: { unit: "operations", total: 312, exposed: 312, excluded: 0 },
    exposure: "discovery",
    outward: 3,
    destructive: 12,
    healthOperation: "getHealth",
    pluginId: "company-box-notes",
    installed: false,
    connection: null,
    credentials: [{ key: "token", label: "API token", secret: true, configured: false }],
    ...overrides,
  };
}

function response(entries: CompanyBoxEntry[]): CompanyBoxResponse {
  return {
    ok: true,
    workspaceSlug: "ws",
    collection: { id: "company-box", label: "Company Box", description: "Your self-hosted apps, whole." },
    secretStoreAvailable: true,
    entries,
    unavailable: [],
  };
}

describe("Company Box client and copy", () => {
  it("labels coverage and exposure", () => {
    expect(coverageLabel(entry())).toBe("312/312 operations");
    expect(exposureLabel(entry())).toBe("Search, describe and call (312 operations)");
    expect(exposureLabel(entry({ exposure: "direct", coverage: { unit: "tools", total: 4, exposed: 3, excluded: 1 } }))).toBe("One tool per tool");
  });

  it("returns the saved entry when only the connection test failed", async () => {
    const saved = entry({ installed: true, connection: { state: "blocked", detail: "The app rejected the credentials.", updatedAt: "2026-10-06T00:00:00Z", baseUrl: "https://notes.t.ts.net" } });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "openapi_auth_rejected", entry: saved }), { status: 502 }));
    await expect(setupCompanyBoxEntry("notes", { baseUrl: "https://notes.t.ts.net", credentials: { token: SECRET } })).resolves.toEqual({ ok: false, error: "openapi_auth_rejected", entry: saved });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/marketplace/company-box/notes/setup");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "company_box_base_url_not_allowed", reason: "address_not_allowed" }), { status: 400 }));
    await expect(setupCompanyBoxEntry("notes", { baseUrl: "https://169.254.169.254" })).rejects.toBeInstanceOf(ApiError);
  });

  it("explains outward approvals and tailnet addresses plainly", () => {
    expect(errorCopy(new ApiError("x", 403, { error: "owner_approval_required_for_outward" })).title).toBe("This sends something outside your workspace");
    expect(errorCopy(new ApiError("x", 400, { error: "company_box_base_url_not_allowed" })).detail).toContain("*.ts.net");
  });
});

describe("Company Box section", () => {
  it("lists entries with coverage and sets one up without echoing the secret", async () => {
    const connected = entry({
      installed: true,
      connection: { state: "connected", detail: "Connected. 312 operations available.", updatedAt: "2026-10-06T00:00:00Z", baseUrl: "https://notes.t.ts.net" },
      credentials: [{ key: "token", label: "API token", secret: true, configured: true, fingerprint: "abc123def456" }],
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/marketplace/company-box" && (!init?.method || init.method === "GET")) {
        const setUp = fetchMock.mock.calls.some(([route]) => String(route).endsWith("/setup"));
        return new Response(JSON.stringify(response([setUp ? connected : entry()])), { status: 200 });
      }
      if (url === "/api/marketplace/company-box/approvals") {
        return new Response(JSON.stringify({ ok: true, workspaceSlug: "ws", pendingCount: 0, approvals: [] }), { status: 200 });
      }
      if (url === "/api/marketplace/company-box/notes/setup") {
        return new Response(JSON.stringify({ ok: true, entry: connected }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client }, createElement(CompanyBoxSection, { onChanged: () => undefined })));
    expect(await screen.findByText("Notes")).toBeTruthy();
    expect(screen.getAllByText("312/312 operations").length).toBeGreaterThan(0);
    expect(screen.getByText("Search, describe and call (312 operations)")).toBeTruthy();
    expect(screen.getByText(/3 outward actions/u)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Set up/u }));
    const address = await screen.findByPlaceholderText("https://notes.your-tailnet.ts.net");
    fireEvent.change(address, { target: { value: "https://notes.t.ts.net" } });
    const token = screen.getByLabelText("API token") as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.change(token, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: /Set up and test/u }));

    expect(await screen.findByText("Notes is connected.")).toBeTruthy();
    const setupCall = fetchMock.mock.calls.find(([route]) => String(route).endsWith("/setup"))!;
    expect(JSON.parse(String(setupCall[1]?.body))).toEqual({ baseUrl: "https://notes.t.ts.net", credentials: { token: SECRET } });
    await waitFor(() => expect(screen.getByText(/abc123def456/u)).toBeTruthy());
    expect(document.body.textContent).not.toContain(SECRET);
  });
});

describe("Company Box approvals panel", () => {
  it("shows waiting requests with agent and argument preview, and approves one", async () => {
    const pending = {
      id: "approval_1",
      pluginId: "company-box-notes",
      app: "Notes",
      actionKey: "company-box-notes.share-note",
      operation: { title: "Email a note to someone", method: "POST", path: "/notes/{id}/share" },
      capability: "connector.dispatch",
      agentId: "agent-7",
      argumentsPreview: '{"path":{"id":"n1"},"body":{"email":"a@b.test"}}',
      state: "pending",
      createdAt: "2026-10-06T00:00:00Z",
      expiresAt: "2026-10-13T00:00:00Z",
      decidedAt: null,
      decidedBy: null,
      error: null,
    };
    let decided = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/marketplace/company-box") return new Response(JSON.stringify(response([entry()])), { status: 200 });
      if (url === "/api/marketplace/company-box/approvals") {
        const approvals = decided ? [{ ...pending, state: "succeeded", decidedBy: "owner" }] : [pending];
        return new Response(JSON.stringify({ ok: true, workspaceSlug: "ws", pendingCount: decided ? 0 : 1, approvals }), { status: 200 });
      }
      if (url === "/api/marketplace/company-box/approvals/approval_1" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ ok: true, approval: pending, arguments: { path: { id: "n1" }, body: { message: "z".repeat(1_000), email: "a@b.test" } } }), { status: 200 });
      }
      if (url === "/api/marketplace/company-box/approvals/approval_1/approve" && init?.method === "POST") {
        decided = true;
        return new Response(JSON.stringify({ ok: true, approval: { ...pending, state: "succeeded" } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client }, createElement(CompanyBoxSection, { onChanged: () => undefined })));
    expect(await screen.findByText("Notes · Email a note to someone")).toBeTruthy();
    expect(screen.getByText("agent-7")).toBeTruthy();
    expect(await screen.findByText('"a@b.test"')).toBeTruthy();
    expect(screen.getByText("truncated for display: 1,000 characters in full")).toBeTruthy();
    // Keys are sorted: body before path, email before message.
    expect([...document.querySelectorAll(".args-view dt")].map((node) => node.textContent)).toEqual(["body", "email", "message", "path", "id"]);
    expect(screen.getByLabelText("1 waiting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Approve/u }));
    expect(await screen.findByText("Approved and ran Email a note to someone.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([route, init]) => String(route).endsWith("/approve") && init?.method === "POST")).toBe(true);
    expect(await screen.findByText("Nothing waiting.")).toBeTruthy();
  });
});

describe("Company Box approvals panel: tool files (#59)", () => {
  it("shows each held file's name, type, size and sha256 with an owner preview and download", () => {
    const sha256 = "ab".repeat(32);
    render(
      createElement(ApprovalFiles, {
        approvalId: "approval_9",
        digest: "cd".repeat(32),
        files: [
          { field: "body.file", fileRef: `tf_${"a".repeat(32)}`, filename: "speaker.png", contentType: "image/png", bytes: 2048, sha256, state: "pinned", previewable: true },
          { field: "body", fileRef: `tf_${"b".repeat(32)}`, filename: "pack.zip", contentType: "application/zip", bytes: 10, sha256, state: "pinned", previewable: false },
        ],
      }),
    );
    expect(screen.getByText("speaker.png")).toBeTruthy();
    expect(screen.getByText("image/png · 2 KiB")).toBeTruthy();
    expect(screen.getAllByText(`sha256 ${sha256}`)).toHaveLength(2);
    const preview = screen.getByAltText("Preview of speaker.png") as HTMLImageElement;
    expect(preview.getAttribute("src")).toBe(`/api/marketplace/company-box/approvals/approval_9/files/tf_${"a".repeat(32)}`);
    const downloads = screen.getAllByText("Download") as HTMLAnchorElement[];
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.getAttribute("href")).toBe(`/api/marketplace/company-box/approvals/approval_9/files/tf_${"a".repeat(32)}?download=1`);
    // Archives and text are listed but never previewed.
    expect(screen.queryByAltText("Preview of pack.zip")).toBeNull();
    expect(screen.getByText("cdcdcdcdcdcd")).toBeTruthy();
  });
});
