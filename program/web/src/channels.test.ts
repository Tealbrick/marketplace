import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelsPage } from "./Channels";
import { capabilityRows, formToPolicy, policyToForm, slugFromLabel, slugProblem, wideningFields } from "./channels-model";
import { ApprovalsPanel } from "./CompanyBox";
import type { ChannelProviderCapabilities, ChannelsBrowseResponse, ChannelView, CompanyBoxApproval, StandingGrantView } from "./types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MALICIOUS = `<img src=x onerror="alert(1)"><script>window.__pwned=1</script>Ops & "chat"`;
const TOKEN_REF = "provider-env:MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN";
const DIGEST = "a1b2c3d4e5f6".padEnd(64, "0");
const MIB = 1024 * 1024;
const DOCUMENTS = ["application/pdf", "text/plain", "application/zip", "application/octet-stream"];
// The provider declaration as the owner browse answer reports it (U2).
const TELEGRAM_CAPS: ChannelProviderCapabilities = {
  text: { maxChars: 4096, captionMaxChars: 1024 },
  markup: "plain",
  image: { types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 10 * MIB, albumMax: 4 },
  file: { types: DOCUMENTS, maxBytes: 50 * MIB },
  audio: { types: ["audio/mpeg", "audio/mp4"], maxBytes: 50 * MIB },
  voice: { native: true, types: ["audio/ogg"], maxBytes: 1 * MIB },
  video: { types: ["video/mp4"], maxBytes: 50 * MIB },
};

function policy(overrides: Partial<ChannelView["policy"]> = {}): ChannelView["policy"] {
  return {
    standingGrants: "allowed",
    caps: { perDay: 6, minIntervalSeconds: 600, onePerPhase: true },
    content: { maxChars: 4096, files: { allowed: true, types: ["image/png", "image/jpeg", "application/pdf"], maxBytes: 10 * 1024 * 1024, maxCount: 4 }, requireConfirmedEvent: false, listingHosts: [], denyPatterns: [] },
    schedule: {},
    ...overrides,
  };
}

function grant(overrides: Partial<StandingGrantView> = {}): StandingGrantView {
  return {
    id: "grant-1",
    channelId: "ch-1",
    agentId: "agent-henry",
    purpose: "Weekly meetup announce, reminder and recap",
    caps: { perDay: 3, minIntervalSeconds: 900, onePerPhase: true },
    scope: { phases: ["announce", "reminder", "recap"], files: { types: ["image/png"], maxBytes: 5 * 1024 * 1024, maxCount: 2 }, immediate: true, scheduled: true },
    notBefore: null,
    expires: "2026-11-01T00:00:00.000Z",
    status: "proposed",
    digest: DIGEST,
    proposedAt: "2026-10-09T10:00:00.000Z",
    approvedAt: null,
    approvalSource: null,
    reason: null,
    ...overrides,
  };
}

function channel(overrides: Partial<ChannelView> = {}): ChannelView {
  return {
    id: "ch-1",
    workspaceSlug: "ws",
    slug: "community",
    label: "Community chat",
    kind: "chat",
    provider: "telegram",
    connectionId: "conn-tg",
    destination: { type: "group", externalId: "-1001", title: MALICIOUS },
    audience: "Members",
    language: "en",
    purpose: "Meetup announcements",
    policy: policy(),
    status: "active",
    revision: 2,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    capabilities: {
      channelCapabilities: 2,
      text: { maxChars: 4096, captionMaxChars: 1024 },
      markup: "plain",
      mentions: { users: false, broadcast: "suppressed" },
      dm: { open: false, maxMembers: 0 },
      image: { types: ["image/png", "image/jpeg"], maxBytes: 10 * 1024 * 1024 },
      file: { types: ["application/pdf"], maxBytes: 10 * 1024 * 1024 },
      audio: false,
      video: false,
      voice: { native: true, types: ["audio/ogg"], maxBytes: 1024 * 1024 },
      maxAttachments: 4,
      thread: { replies: false, topics: true, forum: false },
      reactions: { add: false, remove: false, custom: false },
      edit: { own: false },
      delete: { own: false },
      canvas: false,
      presence: { typing: false, status: false },
      ephemeral: false,
      live: false,
      inbound: { mode: "none", dedupe: false },
      schedule: { native: false },
      limits: { perChatPerSecond: 1, perChatPerMinute: 20, retryAfter: "honoured" },
    },
    usageToday: 1,
    grants: [],
    grantSelection: { pluginId: "channels-telegram", accountId: "conn-tg", resourceKind: "telegram.connected-account", resourceRef: "account:conn-tg", grantClass: "outward", actionGroup: "channel:community", actionGroupLabel: "Community chat" },
    ...overrides,
  };
}

function browse(overrides: Partial<ChannelsBrowseResponse> = {}): ChannelsBrowseResponse {
  const readiness = overrides.readiness ?? { telegram: "available", discord: "credential_missing" };
  return {
    ok: true,
    schema: 1,
    configured: true,
    providers: (["telegram", "discord"] as const).map((id) => ({
      id,
      readiness: readiness[id] ?? "unavailable",
      ...(readiness[id] !== "credential_missing" ? { capabilities: id === "telegram" ? TELEGRAM_CAPS : null, kinds: ["chat"] } : {}),
    })),
    readiness,
    connections: {
      telegram: { connectionId: "conn-tg", state: "connected", botUsername: "tealbrick_bot", verifiedAt: "2026-10-09T00:00:00.000Z", credentialRef: TOKEN_REF } as never,
      discord: null,
    },
    channels: [],
    pendingGrants: [],
    uncertainPosts: [],
    ...overrides,
  };
}

type Route = (init: RequestInit | undefined, url: string) => unknown | Response;

function mockApi(routes: Record<string, Route>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.split("?")[0]!;
    const handler = routes[`${method} ${url}`] ?? routes[`${method} ${path}`];
    if (!handler) {
      if (path === "/api/marketplace/company-box/approvals") return json({ ok: true, workspaceSlug: "ws", pendingCount: 0, approvals: [] });
      if (path === "/api/marketplace/channels/receipts/export") return json({ ok: true, receipts: [] });
      if (path === "/api/marketplace/channels/posts") return json({ ok: true, schema: 1, posts: [] });
      return new Response(JSON.stringify({ ok: false, error: "not_mocked" }), { status: 404 });
    }
    const result = handler(init, url);
    return result instanceof Response ? result : json(result);
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function renderWithClient(element: ReturnType<typeof createElement>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, element));
}

const renderPage = () => renderWithClient(createElement(ChannelsPage, { workspaceSlug: "ws" }));

describe("channels model", () => {
  it("suggests and validates slugs", () => {
    expect(slugFromLabel("Taipei Café Meetups!")).toBe("taipei-cafe-meetups");
    expect(slugFromLabel("台北")).toBe("");
    expect(slugProblem("ok-slug")).toBeNull();
    expect(slugProblem("Bad Slug")).toMatch(/lower-case/u);
    expect(slugProblem("-x")).toMatch(/lower-case/u);
    expect(slugProblem("taken", ["taken"])).toMatch(/already uses/u);
  });

  it("limits the files policy to the provider declaration", () => {
    const telegram = TELEGRAM_CAPS;
    const form = policyToForm(null, telegram);
    // Telegram has no GIF; the §4.3 defaults stay inside what it declares.
    expect(form.fileTypes).toEqual(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
    expect(formToPolicy({ ...form, fileTypes: [...form.fileTypes, "image/gif"] }, telegram).policy?.content?.files?.types).not.toContain("image/gif");
    expect(formToPolicy({ ...form, fileMaxMiB: "60" }, telegram).errors.fileMaxMiB).toMatch(/50 MiB/u);
    expect(formToPolicy({ ...form, perDay: "4", perHour: "5" }, telegram).errors.perHour).toBeTruthy();
    expect(formToPolicy({ ...form, requireConfirmedEvent: true }, telegram).errors.listingHosts).toBeTruthy();
  });

  it("labels the v2 capability keys and marks only declared ones available", () => {
    const base = channel().capabilities!;
    const rows = Object.fromEntries(capabilityRows(base).map((row) => [row.key, row]));
    expect(rows.thread).toMatchObject({ label: "Threads", value: "Forum topics", available: true });
    for (const key of ["dm", "reactions", "edit", "delete", "canvas", "presence", "ephemeral", "live", "inbound"]) {
      expect(rows[key], key).toMatchObject({ value: "Not available", available: false });
    }
    const rich = Object.fromEntries(
      capabilityRows({
        ...base,
        mentions: { users: true, broadcast: "suppressed" },
        dm: { open: true, maxMembers: 8 },
        thread: { replies: true, topics: false, forum: true },
        reactions: { add: true, remove: true, custom: true },
        edit: { own: true, windowSeconds: 900 },
        delete: { own: true },
        canvas: true,
        presence: { typing: true, status: false },
        ephemeral: true,
        live: { join: true, listen: true, speak: false, transcript: true, maxSessionMinutes: 120 },
        inbound: { mode: "socket", dedupe: true },
      }).map((row) => [row.key, row]),
    );
    expect(rich.mentions.value).toMatch(/Named people/u);
    expect(rich.dm).toMatchObject({ label: "Direct messages", value: "Up to 8 people", available: true });
    expect(rich.thread).toMatchObject({ value: "Replies, forum posts", available: true });
    expect(rich.reactions).toMatchObject({ value: "Add, remove, custom emoji", available: true });
    expect(rich.edit).toMatchObject({ label: "Edit own messages", value: "Within 15 min", available: true });
    expect(rich.delete).toMatchObject({ label: "Delete own messages", available: true });
    expect(rich.canvas).toMatchObject({ label: "Canvas", available: true });
    expect(rich.presence).toMatchObject({ label: "Typing and status", value: "Typing", available: true });
    expect(rich.ephemeral.available).toBe(true);
    expect(rich.live).toMatchObject({ label: "Live voice", value: "Join, listen, transcript · up to 120 minutes", available: true });
    expect(rich.inbound).toMatchObject({ label: "Receiving messages", value: "socket · duplicates removed", available: true });
    // A v1 answer (keys absent) shows no v2 feature as available and does not throw.
    const v1 = { ...base, thread: false as const, mentions: "suppressed" as const } as Record<string, unknown>;
    for (const key of ["dm", "reactions", "edit", "delete", "canvas", "presence", "ephemeral", "live", "inbound"]) delete v1[key];
    const old = capabilityRows(v1 as never).filter((row) => ["dm", "reactions", "edit", "delete", "canvas", "presence", "ephemeral", "live", "inbound", "thread"].includes(row.key));
    expect(old.every((row) => !row.available)).toBe(true);
  });

  it("finds every widening field like the server", () => {
    const current = grant();
    const same = { caps: current.caps, scope: current.scope, notBefore: null, expires: current.expires };
    expect(wideningFields(same, same)).toEqual([]);
    expect(wideningFields(same, { ...same, caps: { ...same.caps, perDay: 4 } })).toEqual(["caps.perDay"]);
    expect(wideningFields(same, { ...same, caps: { ...same.caps, minIntervalSeconds: 60 } })).toEqual(["caps.minIntervalSeconds"]);
    expect(wideningFields(same, { ...same, scope: { ...same.scope, phases: undefined } })).toEqual(["scope.phases"]);
    expect(wideningFields(same, { ...same, expires: "2026-12-01T00:00:00.000Z" })).toEqual(["expires"]);
    expect(wideningFields(same, { ...same, caps: { ...same.caps, perDay: 1 }, scope: { ...same.scope, phases: ["announce"], files: false } })).toEqual([]);
  });
});

describe("Channels page", () => {
  it("shows provider readiness and never asks for or echoes a bot token", async () => {
    mockApi({ "GET /api/marketplace/channels": () => browse({ readiness: { telegram: "available", discord: "credential_invalid" } }) });
    renderPage();
    const telegram = await screen.findByLabelText("Telegram readiness");
    expect(within(telegram).getByText("Available")).toBeTruthy();
    expect(within(telegram).getByText("@tealbrick_bot")).toBeTruthy();
    const discord = screen.getByLabelText("Discord readiness");
    expect(within(discord).getByText("Credential invalid")).toBeTruthy();
    expect(within(discord).getByText(/Replace it under Account Connections in Teal Brick Portal/u)).toBeTruthy();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByLabelText(/token/iu)).toBeNull();
    expect(document.body.textContent).not.toContain("MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN");
    cleanup();

    mockApi({ "GET /api/marketplace/channels": () => browse({ readiness: { telegram: "credential_missing", discord: "credential_missing" }, connections: { telegram: null, discord: null } }) });
    renderPage();
    const missing = await screen.findByLabelText("Telegram readiness");
    expect(within(missing).getByText("Credential missing")).toBeTruthy();
    expect(within(missing).getByText("Add the bot token under Account Connections in Teal Brick Portal. Marketplace never asks for the token here.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Add channel/u }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists the v2 capabilities with human-readable labels, only declared ones as available", async () => {
    mockApi({ "GET /api/marketplace/channels": () => browse({ channels: [channel()] }) });
    renderPage();
    const list = (await screen.findAllByLabelText("What agents can send")).find((element) => element.tagName === "DL")!;
    const row = (label: string) => within(list).getByText(label).closest("div")!;
    expect(row("Threads").textContent).toContain("Forum topics");
    expect(row("Threads").className).not.toContain("is-unavailable");
    for (const label of ["Direct messages", "Reactions", "Edit own messages", "Delete own messages", "Canvas", "Typing and status", "Private or expiring messages", "Live voice", "Receiving messages"]) {
      expect(row(label).className, label).toContain("is-unavailable");
      expect(row(label).textContent).toContain("Not available");
    }
  });

  it("renders a malicious chat title as plain text in discovery and the channel list", async () => {
    mockApi({
      "GET /api/marketplace/channels": () => browse({ channels: [channel()] }),
      "GET /api/marketplace/channels/discover": () => ({ ok: true, schema: 1, provider: "telegram", destinations: [{ type: "group", externalId: "-2002", title: MALICIOUS }] }),
    });
    renderPage();
    expect((await screen.findAllByText(MALICIOUS)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Add channel/u }));
    fireEvent.click(screen.getByRole("button", { name: /Discover/u }));
    const list = await screen.findByRole("radiogroup", { name: "Discovered destinations" });
    expect(within(list).getByText(MALICIOUS)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("validates the create form, then creates the channel from the discovered destination", async () => {
    const fetchMock = mockApi({
      "GET /api/marketplace/channels": () => browse(),
      "GET /api/marketplace/channels/discover": () => ({ ok: true, schema: 1, provider: "telegram", destinations: [{ type: "group", externalId: "-3003", title: "Taipei Meetups" }] }),
      "POST /api/marketplace/channels": () => json({ ok: true, channel: channel({ id: "ch-new", label: "Taipei Meetups", slug: "taipei-meetups", destination: { type: "group", externalId: "-3003", title: "Taipei Meetups" } }) }, 201),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Add channel/u }));
    expect(screen.getByText("Add the bot to the chat and send one message, then press Discover.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Discover/u }));
    fireEvent.click(await screen.findByRole("radio", { name: /Taipei Meetups/u }));
    expect((screen.getByLabelText("Kind") as HTMLSelectElement).value).toBe("chat");
    expect([...(screen.getByLabelText("Kind") as HTMLSelectElement).options].map((option) => option.value)).toEqual(["chat"]);
    const label = screen.getByLabelText("Label") as HTMLInputElement;
    const slug = screen.getByLabelText(/^Slug/u) as HTMLInputElement;
    expect(label.value).toBe("Taipei Meetups");
    expect(slug.value).toBe("taipei-meetups");

    fireEvent.change(slug, { target: { value: "Bad Slug" } });
    fireEvent.change(screen.getByLabelText("Posts per day"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /Create channel/u }));
    expect(await screen.findByText(/Use 2–48 lower-case letters/u)).toBeTruthy();
    expect(screen.getByText("Enter a whole number from 1 to 10000.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.change(slug, { target: { value: "taipei-meetups" } });
    fireEvent.change(screen.getByLabelText("Posts per day"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText(/Blocked words/u), { target: { value: "casino\n crypto \n" } });
    fireEvent.click(screen.getByRole("button", { name: /Create channel/u }));
    expect(await screen.findByText("Created Taipei Meetups.")).toBeTruthy();
    const [, init] = fetchMock.mock.calls.find(([url, request]) => String(url) === "/api/marketplace/channels" && request?.method === "POST")!;
    expect((init!.headers as Record<string, string>)["idempotency-key"]).toMatch(/^channel-create-/u);
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ provider: "telegram", slug: "taipei-meetups", label: "Taipei Meetups", kind: "chat", destination: { externalId: "-3003" } });
    expect(body.policy.caps).toEqual({ perDay: 4, minIntervalSeconds: 600, onePerPhase: true });
    expect(body.policy.content.denyPatterns).toEqual(["casino", "crypto"]);
    expect(body.policy.content.files.types).toEqual(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
  });

  it("refuses widening in the narrow editor and shows the server's refusal", async () => {
    const proposed = grant();
    const fetchMock = mockApi({
      "GET /api/marketplace/channels": () => browse({ channels: [channel({ grants: [proposed] })], pendingGrants: [proposed] }),
      "POST /api/marketplace/channels/grants/grant-1/approve": () => json({ ok: false, schema: 1, error: "grant_exceeds_ceiling", fields: ["caps.minIntervalSeconds"] }, 422),
    });
    renderPage();
    const card = await screen.findByLabelText("Standing grant for agent-henry on Community chat");
    expect(within(card).getByText("Weekly meetup announce, reminder and recap")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: /Narrow, then approve/u }));
    const submit = within(card).getByRole("button", { name: /Approve narrowed grant/u }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    fireEvent.change(within(card).getByLabelText("Posts per day"), { target: { value: "5" } });
    expect(within(card).getByRole("alert").textContent).toContain("Posts per day");
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText("Minimum gap (seconds)"), { target: { value: "60" } });
    expect(within(card).getByRole("alert").textContent).toContain("Minimum gap");
    fireEvent.click(submit);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/approve"))).toBe(false);

    fireEvent.change(within(card).getByLabelText("Posts per day"), { target: { value: "2" } });
    fireEvent.change(within(card).getByLabelText("Minimum gap (seconds)"), { target: { value: "1800" } });
    fireEvent.click(within(card).getByRole("checkbox", { name: "recap" }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(await within(card).findByText(/The grant is above the channel ceiling/u)).toBeTruthy();
    expect(within(card).getByLabelText("Refused fields").textContent).toContain("Minimum gap");
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/grants/grant-1/approve"))!;
    expect(JSON.parse(String(init!.body)).final).toEqual({
      caps: { perDay: 2, minIntervalSeconds: 1800, onePerPhase: true },
      scope: { phases: ["announce", "reminder"], files: { types: ["image/png"], maxBytes: 5 * 1024 * 1024, maxCount: 2 }, immediate: true, scheduled: true },
      notBefore: null,
      expires: "2026-11-01T00:00:00.000Z",
    });
  });

  it("resolves an uncertain post only after explaining to check the destination", async () => {
    let resolved = false;
    const fetchMock = mockApi({
      "GET /api/marketplace/channels": () => browse({ channels: [channel({ destination: { type: "group", externalId: "-1001", title: "Ops", url: "https://t.me/ops" } })], uncertainPosts: resolved ? [] : [{ id: "post-9", channelId: "ch-1", agentId: "agent-henry", digest: DIGEST, reason: "send_lease_expired", updatedAt: "2026-10-09T09:00:00.000Z" }] }),
      "POST /api/marketplace/channels/posts/post-9/resolve": () => { resolved = true; return { ok: true, post: { id: "post-9", status: "failed" } }; },
    });
    renderPage();
    const section = (await screen.findByText("Delivery uncertain")).closest("section")!;
    expect(within(section).getByText(DIGEST.slice(0, 12))).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Resolve" }));
    expect(within(section).getByText(/Open the destination and look for the post first/u)).toBeTruthy();
    const open = within(section).getByRole("link", { name: /Open destination/u });
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(open.getAttribute("target")).toBe("_blank");
    fireEvent.click(within(section).getByRole("button", { name: /mark failed/u }));
    expect(await screen.findByText("Marked the post as failed. The agent can post it again.")).toBeTruthy();
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/posts/post-9/resolve"))!;
    expect(JSON.parse(String(init!.body))).toEqual({ status: "failed" });
    await waitFor(() => expect(screen.queryByText("Delivery uncertain")).toBeNull());
  });

  it("lists receipts with safe links and the fallback note", async () => {
    mockApi({
      "GET /api/marketplace/channels": () => browse({ channels: [channel()] }),
      "GET /api/marketplace/channels/receipts/export": () => ({ ok: true, receipts: [
        { resultIds: ["1"], resultUrls: ["https://t.me/c/1/1"], status: "sent", detail: "telegram group Ops", channelId: "ch-1", postId: "p1", digest: DIGEST, authority: "grant:grant-1", approvedAt: null, sentAt: "2026-10-09T08:00:00.000Z", provider: "telegram", fallback: "voice→audio+transcript", agentId: "agent-henry", text: "<b>hi</b>", createdAt: "2026-10-09T08:00:00.000Z" },
        { resultIds: [], resultUrls: ["javascript:alert(1)"], status: "failed", detail: null, channelId: "ch-1", postId: "p2", digest: DIGEST, authority: "approval:a1", approvedAt: null, sentAt: null, provider: "telegram", agentId: "agent-henry", text: null, createdAt: "2026-10-09T07:00:00.000Z" },
        { resultIds: [], resultUrls: [], status: "pending", detail: null, channelId: "ch-1", postId: "p3", digest: DIGEST, authority: "grant:grant-1", approvedAt: null, sentAt: null, provider: "telegram", agentId: "agent-henry", text: "Later", createdAt: "2026-10-09T06:00:00.000Z" },
      ] }),
    });
    renderPage();
    const link = await screen.findByRole("link", { name: /Open post/u });
    expect(link.getAttribute("href")).toBe("https://t.me/c/1/1");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("Fallback applied: voice→audio+transcript")).toBeTruthy();
    expect(screen.getByText("javascript:alert(1)").tagName).toBe("CODE");
    expect(screen.getByText("<b>hi</b>")).toBeTruthy();
  });

  it("shows only provider cards and Portal guidance in inert mode", async () => {
    const fetchMock = mockApi({ "GET /api/marketplace/channels": () => ({ ok: true, schema: 1, configured: false, providers: [{ id: "telegram", readiness: "credential_missing" }, { id: "discord", readiness: "credential_missing" }] }) });
    renderPage();
    expect(await screen.findByText("Channels aren't set up yet")).toBeTruthy();
    expect(within(screen.getByLabelText("Telegram readiness")).getByText("Credential missing")).toBeTruthy();
    expect(within(screen.getByLabelText("Discord readiness")).getByText("Credential missing")).toBeTruthy();
    expect(screen.getAllByText(/Add the bot token under Account Connections in Teal Brick Portal/u).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Add channel|Discover/u })).toBeNull();
    expect(screen.queryByText("Standing grants")).toBeNull();
    expect(screen.queryByText("Receipts")).toBeNull();
    expect(document.querySelector("input, textarea, select")).toBeNull();
    // Inert mode calls nothing but the browse answer.
    expect(new Set(fetchMock.mock.calls.map(([url]) => String(url).split("?")[0]))).toEqual(new Set(["/api/marketplace/channels"]));
  });

  it("lists waiting and scheduled posts and cancels a scheduled one after a confirmation", async () => {
    let cancelled = false;
    const fetchMock = mockApi({
      "GET /api/marketplace/channels": () => browse({ channels: [channel()] }),
      "GET /api/marketplace/channels/posts": () => ({ ok: true, schema: 1, posts: cancelled ? [] : [
        { id: "post-s", channelId: "ch-1", channel: { slug: "community", label: "Community chat", provider: "telegram" }, agentId: "agent-henry", mode: "scheduled", status: "scheduled", sendAt: "2026-10-12T10:00:00.000Z", digestPrefix: DIGEST.slice(0, 12), authority: "grant:grant-1", reason: null, attachments: 1, createdAt: "2026-10-09T10:00:00.000Z" },
        { id: "post-h", channelId: "ch-1", channel: { slug: "community", label: "Community chat", provider: "telegram" }, agentId: "agent-henry", mode: "immediate", status: "held", sendAt: null, digestPrefix: DIGEST.slice(0, 12), authority: null, reason: null, attachments: 0, approval: { id: "a-1", state: "pending", expiresAt: "2026-10-16T10:00:00.000Z" }, createdAt: "2026-10-09T11:00:00.000Z" },
      ] }),
      "POST /api/marketplace/channels/posts/post-s/cancel": () => { cancelled = true; return { ok: true, schema: 1, receipt: { status: "cancelled" } }; },
    });
    renderPage();
    const scheduledRow = await screen.findByLabelText("Scheduled: Community chat");
    const heldRow = screen.getByLabelText("Waiting for approval: Community chat");
    expect(within(heldRow).queryByRole("button", { name: /Cancel/u })).toBeNull();
    expect(within(heldRow).getByText(/Approve or deny it under Posts waiting for approval/u)).toBeTruthy();
    fireEvent.click(within(scheduledRow).getByRole("button", { name: /Cancel/u }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Cancel the scheduled post to Community chat?")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/cancel"))).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel post" }));
    expect(await screen.findByText("Cancelled the scheduled post to Community chat.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText("Scheduled: Community chat")).toBeNull());
    const listCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/marketplace/channels/posts?"))!;
    expect(String(listCall[0])).toContain("status=held%2Cscheduled");
  });

  it("sends a test message after a confirmation that names the destination", async () => {
    const fetchMock = mockApi({
      "GET /api/marketplace/channels": () => browse({ channels: [channel({ destination: { type: "group", externalId: "-1001", title: "Ops room" } })] }),
      "POST /api/marketplace/channels/ch-1/test": () => ({ ok: true, receipt: { resultIds: ["9"], resultUrls: ["https://t.me/c/1/9"], status: "sent", detail: "telegram group Ops room", channelId: "ch-1", postId: "p9", digest: DIGEST, authority: "owner-test", approvedAt: null, sentAt: "2026-10-09T08:00:00.000Z", provider: "telegram" } }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Send test message/u }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Send a test message to Ops room?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Send test message/u }));
    expect(await screen.findByText(/Test message sent/u)).toBeTruthy();
    expect(screen.getByLabelText("Receipt").textContent).toContain("Sent");
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/ch-1/test"))!;
    expect((init!.headers as Record<string, string>)["idempotency-key"]).toMatch(/^channel-test-/u);
  });
});

describe("Approvals panel: channel holds", () => {
  it("shows the full text, files with hash prefixes, the transcript and the digest prefix", async () => {
    const approval: CompanyBoxApproval = {
      id: "approval-ch",
      pluginId: "channels-telegram",
      app: "channels-telegram",
      actionKey: "channel.post",
      operation: { title: "channel.post", method: null, path: null },
      capability: "connector.dispatch",
      agentId: "agent-henry",
      argumentsPreview: "{}",
      state: "pending",
      createdAt: "2026-10-09T10:00:00.000Z",
      expiresAt: "2026-10-16T10:00:00.000Z",
      decidedAt: null,
      decidedBy: null,
      error: null,
      channel: { channelId: "ch-1", label: "Community chat", provider: "telegram", postId: "post-1", postStatus: "held", mode: "immediate", sendAt: null, digest: DIGEST, digestPrefix: DIGEST.slice(0, 12) },
    };
    const text = "Meetup tonight!\n<script>alert(1)</script> @everyone";
    const fetchMock = mockApi({
      "GET /api/marketplace/channels": () => browse({ channels: [channel({ destination: { type: "group", externalId: "-1001", title: "Ops room" } })] }),
      "GET /api/marketplace/company-box/approvals": () => ({ ok: true, workspaceSlug: "ws", pendingCount: 1, approvals: [approval] }),
      "GET /api/marketplace/company-box/approvals/approval-ch": () => ({
        ok: true,
        approval,
        arguments: { postId: "post-1" },
        payloadView: {
          digest: DIGEST,
          matchesHeldDigest: true,
          text,
          canonical: JSON.stringify({ attachments: [{ name: "note.ogg", sha256: "f".repeat(64), contentType: "audio/ogg", kind: "voice", transcript: "See you at seven" }] }),
          files: [
            { name: "poster.png", sha256: "9e8d7c6b5a49".padEnd(64, "1"), contentType: "image/png", kind: "image", bytes: 2048 },
            { name: "note.ogg", sha256: "f".repeat(64), contentType: "audio/ogg", kind: "voice", bytes: 4096 },
          ],
          fallbacks: [],
        },
      }),
      "POST /api/marketplace/company-box/approvals/approval-ch/approve": () => ({ ok: true, approval: { ...approval, state: "succeeded" }, channel: { ok: true, receipt: { status: "sent" } } }),
    });
    renderWithClient(createElement(ApprovalsPanel, { onNotice: () => undefined, only: "channel" }));
    expect(await screen.findByText("Post to Community chat")).toBeTruthy();
    const hold = await screen.findByLabelText("Channel post");
    await waitFor(() => expect(within(hold).getByText("Ops room")).toBeTruthy());
    expect(within(hold).getByText(DIGEST.slice(0, 12))).toBeTruthy();
    expect(hold.querySelector("pre")!.textContent).toBe(text);
    expect(document.querySelector("script")).toBeNull();
    expect(within(hold).getByText("poster.png")).toBeTruthy();
    expect(within(hold).getByText("sha256 9e8d7c6b5a49")).toBeTruthy();
    expect(within(hold).getByText(/No preview is available yet/u)).toBeTruthy();
    expect(within(hold).getByText("See you at seven")).toBeTruthy();
    const approve = screen.getByRole("button", { name: /Approve/u }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/approval-ch/approve") && init?.method === "POST")).toBe(true));
  });

  it("blocks approval when the held payload no longer matches its digest", async () => {
    const approval = {
      id: "approval-x", pluginId: "channels-discord", app: "channels-discord", actionKey: "channel.post", operation: { title: "channel.post", method: null, path: null }, capability: "connector.dispatch", agentId: "agent-2", argumentsPreview: "{}", state: "pending", createdAt: "2026-10-09T10:00:00.000Z", expiresAt: "2026-10-16T10:00:00.000Z", decidedAt: null, decidedBy: null, error: null,
      channel: { channelId: "ch-2", label: "Announcements", provider: "discord", postId: "p", postStatus: "held", mode: "scheduled", sendAt: "2026-10-10T10:00:00.000Z", digest: DIGEST, digestPrefix: DIGEST.slice(0, 12) },
    };
    mockApi({
      "GET /api/marketplace/channels": () => browse(),
      "GET /api/marketplace/company-box/approvals": () => ({ ok: true, workspaceSlug: "ws", pendingCount: 1, approvals: [approval] }),
      "GET /api/marketplace/company-box/approvals/approval-x": () => ({ ok: true, approval, arguments: {}, payloadView: { digest: "b".repeat(64), matchesHeldDigest: false, text: "Voice note\nTranscript: hello", canonical: "{}", files: [], fallbacks: ["voice→audio+transcript"] } }),
    });
    renderWithClient(createElement(ApprovalsPanel, { onNotice: () => undefined }));
    expect(await screen.findByText(/changed after the agent asked/u)).toBeTruthy();
    expect(screen.getByText(/Scheduled for/u)).toBeTruthy();
    expect(screen.getByText(/its transcript is part of the text above/u)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Approve/u }) as HTMLButtonElement).disabled).toBe(true);
  });
});
