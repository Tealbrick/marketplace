import { expect, test } from "@playwright/test";

async function unlockMarketplace(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Marketplace from Teal Brick Portal" })).toBeVisible();
  await page.getByText("Operator recovery").click();
  await page.getByLabel("Operator access token").fill("marketplace-e2e-operator-token");
  await page.getByRole("button", { name: "Unlock Marketplace" }).click();
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();
}

const families = [
  { family: "destructive", label: "Deletes and resets", words: ["DELETE", "REMOVE", "PURGE"] },
  { family: "money", label: "Payments and refunds", words: ["PAY", "REFUND"] },
  { family: "access-sharing", label: "Sharing and permissions", words: ["SHARE", "INVITE"] },
  { family: "bulk", label: "Bulk and broadcast", words: ["BULK_*", "*_ALL"] },
];
const familyState: Record<string, boolean> = {};
const holdFamilies = () => [
  ...families.map((family) => ({ id: family.family, label: family.label, description: `${family.label}.`, words: family.words, defaultOn: true, on: familyState[family.family] ?? true, updatedBy: null, updatedAt: null })),
  { id: "first-contact-dm", label: "First message to a new person", description: "Declared by Channels.", defaultOn: true, on: familyState["first-contact-dm"] ?? true, updatedBy: null, updatedAt: null },
];

test("owner switches an agent between System and Assistant, pauses it, and sees what still waits", async ({ page }) => {
  const state = { mode: "system", paused: false, pausedAll: false };
  const calls: string[] = [];
  const overview = () => ({
    ok: true,
    workspaceSlug: "default",
    governanceMode: "owner",
    pausedAll: state.pausedAll,
    day: "2026-10-11",
    limitsReset: "00:00 UTC",
    defaults: { dailyCap: 100, connectorDailyCap: 50 },
    sensitiveFamilies: families,
    holdFamilies: holdFamilies(),
    agents: [{ agentId: "tempo", mode: state.mode, paused: state.paused, dailyCap: 100, connectorDailyCap: 50, today: { day: "2026-10-11", executed: 3, byConnector: { "gmail-composio": 3 } }, updatedAt: null, updatedBy: null }],
  });
  await page.route("**/api/marketplace/agents", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(overview()) }));
  await page.route("**/api/marketplace/agents/tempo", async (route) => {
    calls.push(`${route.request().method()} ${route.request().postData()}`);
    state.mode = (JSON.parse(route.request().postData() ?? "{}") as { mode?: string }).mode ?? state.mode;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, agent: overview().agents[0] }) });
  });
  await page.route("**/api/marketplace/agents/tempo/pause", async (route) => {
    calls.push("pause");
    state.paused = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, agent: overview().agents[0] }) });
  });
  await page.route("**/api/marketplace/agents/hold-families/*", async (route) => {
    const familyId = route.request().url().split("/").at(-1)!;
    calls.push(`family ${familyId} ${route.request().postData()}`);
    familyState[familyId] = (JSON.parse(route.request().postData() ?? "{}") as { on: boolean }).on;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(overview()) });
  });
  await page.route("**/api/marketplace/agents/pause-all", async (route) => {
    calls.push("pause-all");
    state.pausedAll = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(overview()) });
  });

  await unlockMarketplace(page);
  await page.getByRole("navigation").getByRole("button", { name: "Agent grants" }).click();
  const panel = page.getByRole("region", { name: "Agent approval modes" });
  await expect(panel.getByRole("heading", { name: "Assistant and System agents" })).toBeVisible();
  const row = page.getByTestId("agent-mode-tempo");
  await expect(row).toContainText("System: every outward action waits for your approval.");
  await expect(row).toContainText("3 of 100 outward actions");
  await expect(row).toContainText("UTC day");
  await row.getByRole("button", { name: "Assistant" }).click();
  await expect(row).toContainText("Assistant: this agent sends and changes things without asking you.");
  await expect(row).toContainText("Deletes, payments, refunds, and sharing or permission changes still wait for you.");
  expect(calls[0]).toContain('"mode":"assistant"');
  await panel.getByText("What still waits?").click();
  await expect(panel).toContainText("Payments and refunds");
  await expect(panel.getByText("REFUND", { exact: true })).toBeVisible();
  await expect(panel.getByTestId("hold-family-first-contact-dm")).toContainText("First message to a new person");
  const money = panel.getByTestId("hold-family-money");
  await expect(money.getByRole("checkbox")).toBeChecked();
  await money.getByRole("checkbox").click();
  await expect(money.getByRole("checkbox")).not.toBeChecked();
  await expect(money).toContainText("Assistant agents will do this without asking you.");
  expect(calls).toContain('family money {"on":false}');
  await page.screenshot({ path: process.env.AGENT_MODES_SCREENSHOT ?? "test-results/agent-modes.png", fullPage: true });
  await row.getByRole("button", { name: "Pause tempo" }).click();
  await expect(row).toContainText("Paused: every call from this agent is refused");
  await panel.getByRole("button", { name: "Pause all agents" }).click();
  await expect(panel).toContainText("All agents are paused.");
  expect(calls).toEqual(expect.arrayContaining(["pause", "pause-all"]));
});

test("Activity marks Assistant receipts with their redacted arguments", async ({ page }) => {
  await page.route("**/api/marketplace/audit?*", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        usage: [],
        audit: [
          {
            id: "event-1",
            event_type: "marketplace.agent.outward.receipt",
            plugin_id: "gmail-composio",
            actor_id: "agent:tempo",
            created_at: "2026-10-11T08:00:00.000Z",
            metadata: JSON.stringify({ agentId: "tempo", pluginId: "gmail-composio", account: "ca_1", actionKey: "gmail.send.email", destination: "recipient_email: client@example.invalid", argumentsPreview: '{"subject":"Invoice","api_key":"[redacted]"}', status: "succeeded", mode: "assistant", at: "2026-10-11T08:00:00.000Z" }),
          },
        ],
      }),
    }),
  );
  await unlockMarketplace(page);
  await page.getByRole("navigation").getByRole("button", { name: "Activity" }).click();
  const receipt = page.getByTestId("assistant-receipt");
  await expect(receipt).toContainText("Agent action without approval");
  await expect(receipt).toContainText("gmail.send.email");
  await expect(receipt).toContainText("recipient_email: client@example.invalid");
  await expect(receipt).toContainText("[redacted]");
  await expect(receipt).toContainText("Assistant");
  await page.screenshot({ path: process.env.AGENT_RECEIPTS_SCREENSHOT ?? "test-results/agent-receipts.png", fullPage: true });
});
