import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { composioCoverageReport, DEFAULT_COMPOSIO_POLICY_DIR, runComposioCoverageCli } from "./composio-coverage.js";
import { composioCallIsOutward, composioPolicyFor, composioToolPolicy } from "./composio-policy.js";
import { applyComposioPolicyToListing, buildComposioListingFromTools, resolveActionRequirement } from "./connectors.js";
import { MARKETPLACE_OPERATOR_SESSION_COOKIE, MarketplaceOperatorSessionManager } from "./operator-auth.js";
import { SqliteMarketplaceStore } from "./store.js";

const roots: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const policy = composioPolicyFor("googlecalendar")!;

describe("Composio toolkit policy", () => {
  it("pins destructive, write and read capabilities over name inference", () => {
    const cases: Array<[string, string, string]> = [
      ["GOOGLECALENDAR_CALENDARS_DELETE", "connector.admin", "connector.admin"],
      ["GOOGLECALENDAR_CLEAR_CALENDAR", "connector.observe", "connector.admin"],
      ["GOOGLECALENDAR_BATCH_EVENTS", "connector.observe", "connector.admin"],
      ["GOOGLECALENDAR_PATCH_EVENT", "connector.observe", "connector.dispatch"],
      ["GOOGLECALENDAR_ACL_INSERT", "connector.observe", "connector.dispatch"],
      ["GOOGLECALENDAR_EVENTS_WATCH", "connector.observe", "connector.dispatch"],
      ["GOOGLECALENDAR_SYNC_EVENTS", "connector.dispatch", "connector.observe"],
      ["GOOGLECALENDAR_EVENTS_LIST", "connector.observe", "connector.observe"],
    ];
    for (const [slug, inferred, expected] of cases) {
      expect(composioToolPolicy(policy, slug, inferred as never).capability, slug).toBe(expected);
    }
    expect(composioToolPolicy(policy, "GOOGLECALENDAR_DELETE_EVENT", "connector.admin")).toEqual({ capability: "connector.admin", outward: "unlessQuiet", destructive: true });
    expect(composioToolPolicy(policy, "GOOGLECALENDAR_ACL_PATCH", "connector.observe")).toMatchObject({ outward: "always" });
    expect(composioToolPolicy(policy, "GOOGLECALENDAR_SETTINGS_WATCH", "connector.observe")).toMatchObject({ outward: "always" });
    expect(composioToolPolicy(policy, "GOOGLECALENDAR_EVENTS_GET", "connector.observe")).toEqual({ capability: "connector.observe", outward: null, destructive: false });
  });

  it("treats attendee-notifying event tools as outward unless the call is explicitly quiet", () => {
    const create = "GOOGLECALENDAR_CREATE_EVENT";
    expect(composioCallIsOutward(policy, create, { summary: "x" })).toBe(true);
    expect(composioCallIsOutward(policy, create, { summary: "x", send_updates: "all" })).toBe(true);
    expect(composioCallIsOutward(policy, create, { summary: "x", send_updates: "externalOnly" })).toBe(true);
    expect(composioCallIsOutward(policy, create, { summary: "x", send_updates: "none" })).toBe(false);
    expect(composioCallIsOutward(policy, create, { summary: "x", sendUpdates: "none" })).toBe(false);
    expect(composioCallIsOutward(policy, create, { send_updates: "none", attendees: ["a@b.test"] })).toBe(true);
    expect(composioCallIsOutward(policy, create, { send_updates: "none", attendees: [] })).toBe(false);
    expect(composioCallIsOutward(policy, "GOOGLECALENDAR_DELETE_EVENT", { send_updates: "none", send_notifications: true })).toBe(true);
    expect(composioCallIsOutward(policy, create, undefined)).toBe(true);
    // Always-outward tools stay outward even when quiet.
    expect(composioCallIsOutward(policy, "GOOGLECALENDAR_ACL_INSERT", { send_updates: "none" })).toBe(true);
    expect(composioCallIsOutward(policy, "GOOGLECALENDAR_REMOVE_ATTENDEE", { send_updates: "none" })).toBe(true);
    expect(composioCallIsOutward(policy, "GOOGLECALENDAR_EVENTS_LIST", {})).toBe(false);
  });

  it("applies to new listings and re-applies to listings imported before the policy", () => {
    const listing = buildComposioListingFromTools({
      toolkit: "googlecalendar",
      tools: [{ name: "GOOGLECALENDAR_PATCH_EVENT" }, { name: "GOOGLECALENDAR_CLEAR_CALENDAR" }, { name: "GOOGLECALENDAR_EVENTS_LIST" }],
    });
    expect(resolveActionRequirement(listing, "googlecalendar.patch.event")?.capability).toBe("connector.dispatch");
    expect(resolveActionRequirement(listing, "googlecalendar.clear.calendar")?.capability).toBe("connector.admin");
    expect(listing.capabilities).toEqual(["connector.admin", "connector.dispatch", "connector.observe"]);
    expect(applyComposioPolicyToListing(listing)).toBeNull();
    const stale = JSON.parse(JSON.stringify(listing));
    stale.manifest.actionRequirements["googlecalendar.patch.event"].capability = "connector.observe";
    stale.manifest.composio.tools = stale.manifest.composio.tools.map((tool: Record<string, unknown>) => ({ ...tool, capability: "connector.observe", outward: undefined }));
    const refreshed = applyComposioPolicyToListing(stale)!;
    expect(resolveActionRequirement(refreshed, "googlecalendar.patch.event")?.capability).toBe("connector.dispatch");
    expect((refreshed.manifest.composio as { tools: Array<Record<string, unknown>> }).tools.find((tool) => tool.toolName === "GOOGLECALENDAR_PATCH_EVENT")).toMatchObject({ outward: "unlessQuiet" });
    // Toolkits without a policy are untouched.
    const github = buildComposioListingFromTools({ toolkit: "github", tools: [{ name: "GITHUB_LIST_REPOSITORIES" }] });
    expect(applyComposioPolicyToListing(github)).toBeNull();
  });
});

describe("Composio coverage", () => {
  function copy(patch?: (files: { api: Record<string, unknown>; policy: Record<string, unknown> }) => void) {
    const dir = tempDir("composio-coverage-");
    cpSync(DEFAULT_COMPOSIO_POLICY_DIR, dir, { recursive: true });
    if (patch) {
      const apiFile = path.join(dir, "googlecalendar.api-methods.json");
      const policyFile = path.join(dir, "googlecalendar.json");
      const files = { api: JSON.parse(readFileSync(apiFile, "utf8")), policy: JSON.parse(readFileSync(policyFile, "utf8")) };
      patch(files);
      writeFileSync(apiFile, JSON.stringify(files.api));
      writeFileSync(policyFile, JSON.stringify(files.policy));
    }
    return dir;
  }

  it("maps every Calendar v3 method to a tool or a reasoned exclusion and lists the extras", () => {
    const report = composioCoverageReport(copy());
    expect(report.ok).toBe(true);
    const calendar = report.toolkits[0]!;
    expect(calendar).toMatchObject({ toolkit: "googlecalendar", methods: 38, mapped: 37, unmapped: 1, tools: 50, revision: "20260925" });
    expect(calendar.items.find((item) => item.status === "unmapped")).toMatchObject({ method: "calendar.calendars.transferOwnership" });
    expect(calendar.extras).toEqual(expect.arrayContaining(["GOOGLECALENDAR_GET_CURRENT_DATE_TIME", "GOOGLECALENDAR_LIST_BUILDINGS"]));
    expect(calendar.toolItems.filter((tool) => tool.capability === "connector.observe").every((tool) => !tool.outward)).toBe(true);
  });

  it("fails when a method has no tool, a mapping names a missing tool, or a policy pattern matches nothing", () => {
    const noTool = composioCoverageReport(copy(({ api }) => {
      const methods = api.methods as Array<Record<string, unknown>>;
      delete methods.find((method) => method.id === "calendar.colors.get")!.tools;
    }));
    expect(noTool.ok).toBe(false);
    expect(noTool.toolkits[0]!.errors).toContain("calendar.colors.get maps to no tool and is not listed as unmapped.");
    const missing = composioCoverageReport(copy(({ api }) => {
      (api.methods as Array<Record<string, unknown>>)[0]!.tools = ["GOOGLECALENDAR_NOT_A_TOOL"];
    }));
    expect(missing.toolkits[0]!.errors[0]).toMatch(/tools missing from the snapshot: GOOGLECALENDAR_NOT_A_TOOL/u);
    const reasonless = composioCoverageReport(copy(({ api }) => {
      (api.unmapped as Array<Record<string, unknown>>)[0]!.reason = " ";
    }));
    expect(reasonless.toolkits[0]!.errors).toContain("Unmapped method calendar.calendars.transferOwnership has no reason.");
    const typo = composioCoverageReport(copy(({ policy: file }) => {
      (file.destructive as string[]).push("GOOGLECALENDAR_CALENDAR_DELTE");
    }));
    expect(typo.toolkits[0]!.errors).toEqual(expect.arrayContaining(['destructive pattern "GOOGLECALENDAR_CALENDAR_DELTE" matches no tool in the snapshot.']));
    const lines: string[] = [];
    expect(runComposioCoverageCli(["--no-write"], { dir: copy(({ policy: file }) => ((file.writes as string[]).length = 0)) }, (line) => lines.push(line))).toBe(1);
    expect(lines.join("\n")).toContain("classifies as connector.observe; add it to writes");
  });
});

describe("Composio governance (owner approval mode)", () => {
  async function fixture() {
    const dir = tempDir("composio-governance-");
    const store = new SqliteMarketplaceStore(path.join(dir, "marketplace.sqlite"));
    const executions: Array<{ tool: string; body: Record<string, unknown> }> = [];
    const sessions = new MarketplaceOperatorSessionManager({ accessToken: "operator-access-token", organizationId: "atlas" });
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: "marketplace-service-token",
      organizationId: "atlas",
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      environment: { NODE_ENV: "test" },
      operatorSessionManager: sessions,
      providerFetch: async (input, init) => {
        const match = /\/tools\/execute\/([A-Z_]+)/u.exec(String(input));
        if (match) {
          executions.push({ tool: match[1]!, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
          return new Response(JSON.stringify({ data: { id: "evt-1" }, successful: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
      agentScopeVerifier: async ({ requiredCapability }) => ({
        organizationId: "atlas",
        agentId: "tempo",
        attachmentId: "attachment-1",
        capabilities: [requiredCapability],
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      }),
    });
    closers.push(async () => {
      await app.close();
      store.close();
    });
    const service = { authorization: "Bearer marketplace-service-token" };
    const agent = { ...service, "x-tealbrick-agent-token": "tempo", "x-tealbrick-attachment": "attachment-1" };
    const imported = await app.inject({
      method: "POST",
      url: "/api/marketplace/catalog/composio/import",
      headers: service,
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
        toolkit: "googlecalendar",
        pluginId: "googlecalendar-composio",
        autoEnable: true,
        tools: ["EVENTS_LIST", "CREATE_EVENT", "ACL_INSERT", "CALENDARS_DELETE", "PATCH_EVENT"].map((slug) => ({ name: `GOOGLECALENDAR_${slug}` })),
      },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    store.upsertConnection({
      workspaceSlug: "atlas",
      pluginId: "googlecalendar-composio",
      provider: "googlecalendar",
      backend: "composio",
      state: "connected",
      detail: "connected",
      metadata: { connectedAccountId: "ca_tempo" },
    });
    const { token, status } = sessions.issuePortalSession({ id: "owner", organizationId: "atlas" });
    const operator = { cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${encodeURIComponent(token)}`, origin: "http://127.0.0.1:5314", "x-csrf-token": status.csrfToken! };
    const grant = async (actionKey: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/marketplace/agent/grants",
        headers: agent,
        payload: { workspaceSlug: "atlas", pluginId: "googlecalendar-composio", actionKey, accountId: "ca_tempo", resourceKind: "googlecalendar.connected-account", resourceRef: "account:ca_tempo" },
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json().grant.id as string;
    };
    const tool = (actionKey: string, input: Record<string, unknown>, grantId: string) =>
      app.inject({
        method: "POST",
        url: `/api/agent/tools/marketplace.${actionKey}`,
        headers: agent,
        payload: { workspaceSlug: "atlas", pluginId: "googlecalendar-composio", input, grantId },
      });
    return { app, store, executions, operator, grant, tool };
  }

  it("holds notifying event writes and calendar sharing for approval; quiet writes and reads run", async () => {
    const f = await fixture();
    const listing = f.store.getListing("googlecalendar-composio")!;
    expect(resolveActionRequirement(listing, "googlecalendar.patch.event")?.capability).toBe("connector.dispatch");
    expect(resolveActionRequirement(listing, "googlecalendar.calendars.delete")?.capability).toBe("connector.admin");

    const list = await f.grant("googlecalendar.events.list");
    expect((await f.tool("googlecalendar.events.list", { calendar_id: "primary" }, list)).statusCode).toBe(200);
    expect(f.executions.map((execution) => execution.tool)).toEqual(["GOOGLECALENDAR_EVENTS_LIST"]);

    const create = await f.grant("googlecalendar.create.event");
    const invite = await f.tool("googlecalendar.create.event", { summary: "Kickoff", attendees: ["client@example.com"], send_updates: "all" }, create);
    expect(invite.statusCode, invite.body).toBe(202);
    expect(invite.json()).toMatchObject({ status: "approval_pending", approvalId: expect.any(String) });
    const unstated = await f.tool("googlecalendar.create.event", { summary: "Focus" }, create);
    expect(unstated.statusCode).toBe(202);
    const quiet = await f.tool("googlecalendar.create.event", { summary: "Focus", send_updates: "none" }, create);
    expect(quiet.statusCode, quiet.body).toBe(200);
    expect(f.executions.map((execution) => execution.tool)).toEqual(["GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_CREATE_EVENT"]);

    const share = await f.grant("googlecalendar.acl.insert");
    expect((await f.tool("googlecalendar.acl.insert", { calendar_id: "primary", role: "reader", send_updates: "none" }, share)).statusCode).toBe(202);

    const approvals = (await f.app.inject({ method: "GET", url: "/api/marketplace/company-box/approvals?state=pending", headers: f.operator })).json();
    expect(approvals.pendingCount).toBe(3);
    expect(approvals.approvals.map((approval: { operation: { title: string } }) => approval.operation.title)).toEqual(expect.arrayContaining(["Create Event"]));
    const approved = await f.app.inject({ method: "POST", url: `/api/marketplace/company-box/approvals/${invite.json().approvalId}/approve`, headers: f.operator });
    expect(approved.json(), approved.body).toMatchObject({ ok: true, approval: { state: "succeeded" } });
    expect(f.executions.at(-1)).toMatchObject({ tool: "GOOGLECALENDAR_CREATE_EVENT", body: { arguments: { summary: "Kickoff", attendees: ["client@example.com"], send_updates: "all" } } });
    expect(f.executions).toHaveLength(3);
  });

  it("requires admin for destructive tools", async () => {
    const f = await fixture();
    const remove = await f.grant("googlecalendar.calendars.delete");
    const asDispatch = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/googlecalendar-composio/execute",
      headers: f.operator,
      payload: { workspaceSlug: "atlas", capability: "connector.dispatch", action: { type: "googlecalendar.calendars.delete", calendar_id: "c1" } },
    });
    expect(asDispatch.statusCode).toBe(400);
    expect(asDispatch.json()).toMatchObject({ error: "connector_capability_mismatch", requiredCapability: "connector.admin" });
    expect((await f.tool("googlecalendar.calendars.delete", { calendar_id: "c1" }, remove)).statusCode).toBe(200);
    const audit = f.store.listAudit({ workspaceSlug: "atlas", limit: 500 }) as Array<{ event_type: string; metadata: string }>;
    expect(audit.some((row) => row.event_type === "marketplace.governance.owner_approved" && row.metadata.includes('"destructive":true'))).toBe(true);
    f.store.bindCapability({ workspaceSlug: "atlas", pluginId: "googlecalendar-composio", capability: "connector.admin", enabled: false });
    // Without the admin binding the destructive tool is not offered at all.
    const denied = await f.tool("googlecalendar.calendars.delete", { calendar_id: "c1" }, remove);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toMatchObject({ error: "agent_tool_not_available" });
    expect(f.executions.filter((execution) => execution.tool === "GOOGLECALENDAR_CALENDARS_DELETE")).toHaveLength(1);
  });
});
