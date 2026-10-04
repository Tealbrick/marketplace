import { expect, test } from "@playwright/test";

async function unlockMarketplace(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Marketplace from Teal Brick Portal" })).toBeVisible();
  await page.getByText("Operator recovery").click();
  await page.getByLabel("Operator access token").fill("marketplace-e2e-operator-token");
  await page.getByRole("button", { name: "Unlock Marketplace" }).click();
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();
}

test("runs request, explicit Portal approval, return, and reconcile through the paired backend", async ({ page, context }) => {
  await unlockMarketplace(page);
  await page.getByRole("button", { name: "Agent grants" }).click();
  await page.getByLabel("Portal deployment ID").fill("deployment-1");
  await page.getByLabel("Agent selection").fill("agent-1");
  await expect(page.getByLabel("Connected account")).toHaveValue("ca_1");
  await page.getByRole("button", { name: "Request Portal consent" }).click();

  const request = page.getByTestId(/^handoff-request-/u).first();
  await expect(request).toContainText("Pending");
  const approvalUrl = await request.getByRole("link", { name: "Open Portal review" }).getAttribute("href");
  expect(approvalUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/portal\?requestId=/u);

  const portalPage = await context.newPage();
  await portalPage.goto(approvalUrl!);
  await expect(portalPage.getByRole("heading", { name: "Portal consent review" })).toBeVisible();
  await portalPage.getByRole("button", { name: "Approve consent" }).click();
  await expect(portalPage.getByRole("heading", { name: "Approved" })).toBeVisible();
  await portalPage.close();

  await request.getByRole("button", { name: "Reconcile approval" }).click();
  await expect(page.getByRole("heading", { name: "Recorded grants" })).toBeVisible();
  await expect(page.getByTestId(/agent-grant-marketplace_consent_/u)).toContainText("Active");

  await page.reload();
  await page.getByRole("button", { name: "Agent grants" }).click();
  await expect(page.getByTestId(/agent-grant-marketplace_consent_/u)).toContainText("Durable consent");
});

test("paired backend rejects missing CSRF and wrong tenant scope in the browser", async ({ page }) => {
  await unlockMarketplace(page);
  const csrf = await page.evaluate(async () => {
    const response = await fetch("/api/marketplace/v1/agent/grants/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploymentId: "deployment-1", agentId: "agent-1", selection: { pluginId: "github-composio", actionKey: "github.list.repositories", accountId: "ca_1", resourceKind: "github.connected-account", resourceRef: "account:ca_1" }, idempotencyKey: "missing-csrf" }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(csrf).toMatchObject({ status: 403, body: { error: "marketplace_csrf_denied" } });

  const tenant = await page.evaluate(async () => {
    const response = await fetch("/api/marketplace/agent/grants?workspaceSlug=foreign-tenant");
    return { status: response.status, body: await response.json() };
  });
  expect(tenant).toMatchObject({ status: 200, body: { workspaceSlug: "default" } });

  const wrongDeployment = await page.evaluate(async () => {
    const sessionResponse = await fetch("/api/marketplace/auth/session");
    const session = await sessionResponse.json() as { session: { csrfToken: string } };
    const response = await fetch("/api/marketplace/v1/agent/grants/request", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": session.session.csrfToken },
      body: JSON.stringify({ deploymentId: "foreign-deployment", agentId: "agent-1", selection: { pluginId: "github-composio", actionKey: "github.list.repositories", accountId: "ca_1", resourceKind: "github.connected-account", resourceRef: "account:ca_1" }, idempotencyKey: "wrong-deployment" }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(wrongDeployment).toMatchObject({ status: 409, body: { error: "portal_session_required" } });
});

test("paired backend exposes expired handoff state without a reconcile action", async ({ page }) => {
  await unlockMarketplace(page);
  await page.getByRole("button", { name: "Agent grants" }).click();
  await page.getByLabel("Portal deployment ID").fill("deployment-1");
  await page.getByLabel("Agent selection").fill("agent-expired");
  await expect(page.getByLabel("Connected account")).toHaveValue("ca_1");
  await page.getByRole("button", { name: "Request Portal consent" }).click();
  const request = page.getByTestId(/^handoff-request-/u).first();
  await expect(request).toContainText("Expired");
  await expect(request.getByRole("button", { name: "Reconcile approval" })).toHaveCount(0);
});

test("paired Portal denial fails reconciliation without creating a grant", async ({ page, context }) => {
  await unlockMarketplace(page);
  await page.getByRole("button", { name: "Agent grants" }).click();
  await page.getByLabel("Portal deployment ID").fill("deployment-1");
  await page.getByLabel("Agent selection").fill("agent-denied");
  await expect(page.getByLabel("Connected account")).toHaveValue("ca_1");
  await page.getByRole("button", { name: "Request Portal consent" }).click();
  const request = page.getByTestId(/^handoff-request-/u).first();
  const approvalUrl = await request.getByRole("link", { name: "Open Portal review" }).getAttribute("href");
  const portalPage = await context.newPage();
  await portalPage.goto(approvalUrl!);
  await portalPage.getByRole("button", { name: "Deny consent" }).click();
  await portalPage.close();
  await request.getByRole("button", { name: "Reconcile approval" }).click();
  await expect(page.getByText("portal_handoff_denied")).toBeVisible();
  await expect(page.locator('[data-testid^="agent-grant-"]').filter({ hasText: "agent-denied" })).toHaveCount(0);
});
