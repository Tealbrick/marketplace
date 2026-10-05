import { expect, test } from "@playwright/test";

async function unlockMarketplace(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Marketplace from Teal Brick Portal" })).toBeVisible();
  await page.getByText("Operator recovery").click();
  await page.getByLabel("Operator access token").fill("marketplace-e2e-operator-token");
  await page.getByRole("button", { name: "Unlock Marketplace" }).click();
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();
}

test("renders positive, denied, and expired grant scope from the browser fixture", async ({ page }) => {
  await page.route("**/api/marketplace/agent/grants?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        contractVersion: "doppelganger.marketplace.agent-connector-grant.v1",
        workspaceSlug: "default",
        grants: [
          {
            id: "grant-allowed",
            workspaceSlug: "default",
            agentId: "agent-1",
            pluginId: "github-composio",
            actionKey: "github.list.repositories",
            capability: "connector.observe",
            connectionId: "connection-1",
            accountId: "ca_agent_1",
            resourceKind: "github.connected-account",
            resourceRef: "account:ca_agent_1",
            state: "active",
            expiresAt: "2099-01-01T00:00:00.000Z",
            createdAt: "2026-10-02T08:00:00.000Z",
            updatedAt: "2026-10-02T08:00:00.000Z",
          },
          {
            id: "grant-denied",
            workspaceSlug: "default",
            agentId: "agent-2",
            pluginId: "github-composio",
            actionKey: "github.list.repositories",
            capability: "connector.observe",
            connectionId: "connection-1",
            accountId: "ca_agent_1",
            resourceKind: "github.connected-account",
            resourceRef: "account:ca_agent_1",
            state: "revoked",
            expiresAt: "2099-01-01T00:00:00.000Z",
            createdAt: "2026-10-02T08:00:00.000Z",
            updatedAt: "2026-10-02T08:05:00.000Z",
          },
          {
            id: "grant-expired",
            workspaceSlug: "default",
            agentId: "agent-3",
            pluginId: "github-composio",
            actionKey: "github.list.repositories",
            capability: "connector.observe",
            connectionId: "connection-1",
            accountId: "ca_agent_1",
            resourceKind: "github.connected-account",
            resourceRef: "account:ca_agent_1",
            state: "active",
            expiresAt: "2020-01-01T00:00:00.000Z",
            createdAt: "2026-10-02T08:00:00.000Z",
            updatedAt: "2026-10-02T08:05:00.000Z",
          },
        ],
        handoffRequests: [],
        consents: [],
        handoffContractVersion: "tealbrick.marketplace.operator-handoff.v1.1",
        grantCreation: {
          available: false,
          code: "portal_handoff_required",
          detail: "Portal must provide a server-side or opaque human-authorized handoff before browser grant creation is enabled.",
        },
      }),
    });
  });

  await unlockMarketplace(page);
  await page.getByRole("button", { name: "Agent grants" }).click();
  await expect(page.getByRole("heading", { name: "Agent grants" })).toBeVisible();
  await expect(page.getByText("Agents get access only through Portal approval")).toBeVisible();
  await expect(page.getByTestId("agent-grant-grant-allowed")).toContainText("Active");
  await expect(page.getByTestId("agent-grant-grant-denied")).toContainText("Revoked");
  await expect(page.getByTestId("agent-grant-grant-expired")).toContainText("Expired");
  await expect(page.getByTestId("agent-grant-grant-allowed")).toContainText("github.connected-account:account:ca_agent_1");
});

test("revokes an active grant through the operator session and refreshes status", async ({ page }) => {
  let revoked = false;
  const grant = {
    id: "grant-revoke",
    workspaceSlug: "default",
    agentId: "agent-1",
    pluginId: "github-composio",
    actionKey: "github.list.repositories",
    capability: "connector.observe",
    connectionId: "connection-1",
    accountId: "ca_agent_1",
    resourceKind: "github.connected-account",
    resourceRef: "account:ca_agent_1",
    state: "active",
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-10-02T08:00:00.000Z",
    updatedAt: "2026-10-02T08:00:00.000Z",
  };
  await page.route("**/api/marketplace/agent/grants?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        contractVersion: "doppelganger.marketplace.agent-connector-grant.v1",
        workspaceSlug: "default",
        grants: [{ ...grant, state: revoked ? "revoked" : "active" }],
        handoffRequests: [],
        consents: [],
        handoffContractVersion: "tealbrick.marketplace.operator-handoff.v1.1",
        grantCreation: { available: false, code: "portal_handoff_required", detail: "Creation is pending the Portal handoff." },
      }),
    });
  });
  await page.route("**/api/marketplace/agent/grants/grant-revoke/revoke", async (route) => {
    expect(route.request().method()).toBe("POST");
    revoked = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, traceId: "trace-revoke", grant: { ...grant, state: "revoked" } }) });
  });

  await unlockMarketplace(page);
  await page.getByRole("button", { name: "Agent grants" }).click();
  const row = page.getByTestId("agent-grant-grant-revoke");
  await expect(row).toContainText("Active");
  await row.getByRole("button", { name: "Revoke grant for agent-1" }).click();
  const confirm = page.getByRole("dialog", { name: "Revoke access for agent-1?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Revoke grant" }).click();
  await expect(row).toContainText("Revoked");
  await expect(row.getByRole("button", { name: "Revoke grant for agent-1" })).toHaveCount(0);
});

test("requests a bounded Portal consent and reconciles the approved projection", async ({ page }) => {
  let phase: "pending" | "redeemed" = "pending";
  let requestCalls = 0;
  let redeemCalls = 0;
  const requestId = "r".repeat(43);
  const consentId = "consent-1";
  const selection = {
    pluginId: "github-composio",
    actionKey: "github.list.repositories",
    accountId: "ca_1",
    resourceKind: "github.connected-account",
    resourceRef: "account:ca_1",
  };
  const pending = {
    id: "request-1",
    portalOrgId: "org-1",
    productTenantId: "default",
    workspaceId: "workspace-1",
    deploymentId: "deployment-1",
    agentId: "agent-1",
    requestId,
    approvalUrl: "https://portal.test/portal?requestId=" + requestId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    idempotencyKey: "marketplace-fixture-request",
    selection,
    state: "pending",
    consentId: null,
    createdAt: "2026-10-02T08:00:00.000Z",
    updatedAt: "2026-10-02T08:00:00.000Z",
  };
  const consent = {
    id: "marketplace_consent_1",
    portalOrgId: "org-1",
    productTenantId: "default",
    workspaceId: "workspace-1",
    deploymentId: "deployment-1",
    userId: "operator-1",
    agentId: "agent-1",
    consentId,
    consentRevision: 1,
    pluginId: selection.pluginId,
    actionKey: selection.actionKey,
    capability: "connector.observe",
    connectionId: "connection-1",
    accountId: selection.accountId,
    resourceKind: selection.resourceKind,
    resourceRef: selection.resourceRef,
    state: "active",
    capabilities: ["connector.observe"],
    requiredActions: ["read"],
    createdAt: "2026-10-02T08:00:00.000Z",
    updatedAt: "2026-10-02T08:05:00.000Z",
  };
  await page.route("**/api/marketplace/agent/grants?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        contractVersion: "doppelganger.marketplace.agent-connector-grant.v1",
        workspaceSlug: "default",
        grants: [],
        handoffRequests: [{ ...pending, state: phase }],
        consents: phase === "redeemed" ? [consent] : [],
        handoffContractVersion: "tealbrick.marketplace.operator-handoff.v1.1",
        grantCreation: { available: false, code: "portal_handoff_required", detail: "Direct creation is disabled." },
      }),
    });
  });
  await page.route("**/api/marketplace/v1/agent/grants/request", async (route) => {
    requestCalls += 1;
    const body = route.request().postDataJSON();
    expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
    expect(body).toMatchObject({ deploymentId: "deployment-1", agentId: "agent-1", selection, idempotencyKey: expect.stringMatching(/^marketplace-/u) });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, schema: 1, contractVersion: "tealbrick.marketplace.operator-handoff.v1.1", authority: "marketplace_operator_session", request: { requestId, approvalUrl: pending.approvalUrl, expiresAt: Date.parse(pending.expiresAt) }, projection: pending }) });
  });
  await page.route("**/api/marketplace/v1/agent/grants/redeem", async (route) => {
    redeemCalls += 1;
    expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
    expect(route.request().postDataJSON()).toEqual({ deploymentId: "deployment-1", requestId });
    phase = "redeemed";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, schema: 1, contractVersion: "tealbrick.marketplace.operator-handoff.v1.1", authority: "marketplace_operator_session", traceId: "trace-redeem", reconciled: false, created: true, consent, projection: { ...pending, state: "redeemed", consentId } }) });
  });

  await routeActionCatalog(page);

  await unlockMarketplace(page);
  await page.getByRole("button", { name: "Agent grants" }).click();
  await page.getByText("Developer details").click();
  await page.getByLabel("Portal deployment ID").fill("deployment-1");
  await page.getByLabel("Agent selection").fill("agent-1");
  await page.getByLabel("Connector").selectOption("github-composio");
  await page.getByLabel("Action", { exact: true }).selectOption("github.list.repositories");
  // Single connected account is auto-selected and fixes the resource scope.
  await expect(page.getByLabel("Connected account")).toHaveValue("ca_1");
  await expect(page.getByLabel("Resource scope")).toHaveValue("account:ca_1");
  await expect(page.getByTestId("grant-capability")).toContainText("Read only");
  await page.getByRole("button", { name: "Request approval in Portal" }).click();
  await expect(page.getByText("Approval requested")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Portal review" }).first()).toHaveAttribute("href", pending.approvalUrl);
  await expect(page.getByTestId(`handoff-request-${requestId}`)).toContainText("Pending");
  await page.getByTestId(`handoff-request-${requestId}`).getByRole("button", { name: "Reconcile approval" }).click();
  await expect(page.getByTestId("agent-grant-marketplace_consent_1")).toContainText("Active");
  expect(requestCalls).toBe(1);
  expect(redeemCalls).toBe(1);

  await page.reload();
  await page.getByRole("button", { name: "Agent grants" }).click();
  await expect(page.getByTestId("agent-grant-marketplace_consent_1")).toContainText("Durable consent");
  expect(requestCalls).toBe(1);
});

test("keeps denied and expired Portal requests non-actionable", async ({ page }) => {
  await page.route("**/api/marketplace/agent/grants?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        contractVersion: "doppelganger.marketplace.agent-connector-grant.v1",
        workspaceSlug: "default",
        grants: [],
        handoffRequests: [
          { id: "request-denied", portalOrgId: "org-1", productTenantId: "default", workspaceId: "workspace-1", deploymentId: "deployment-1", agentId: "agent-denied", requestId: "d".repeat(43), approvalUrl: "https://portal.test/denied", expiresAt: "2099-01-01T00:00:00.000Z", idempotencyKey: "marketplace-denied", selection: { ...selectionForFixture("ca_denied") }, state: "denied", consentId: null, createdAt: "2026-10-02T08:00:00.000Z", updatedAt: "2026-10-02T08:01:00.000Z" },
          { id: "request-expired", portalOrgId: "org-1", productTenantId: "default", workspaceId: "workspace-1", deploymentId: "deployment-1", agentId: "agent-expired", requestId: "e".repeat(43), approvalUrl: "https://portal.test/expired", expiresAt: "2020-01-01T00:00:00.000Z", idempotencyKey: "marketplace-expired", selection: { ...selectionForFixture("ca_expired") }, state: "pending", consentId: null, createdAt: "2026-10-02T08:00:00.000Z", updatedAt: "2026-10-02T08:01:00.000Z" },
        ],
        consents: [],
        handoffContractVersion: "tealbrick.marketplace.operator-handoff.v1.1",
        grantCreation: { available: false, code: "portal_handoff_required", detail: "Direct creation is disabled." },
      }),
    });
  });
  await unlockMarketplace(page);
  await page.getByRole("button", { name: "Agent grants" }).click();
  await expect(page.getByTestId(`handoff-request-${"d".repeat(43)}`)).toContainText("Denied");
  await expect(page.getByTestId(`handoff-request-${"e".repeat(43)}`)).toContainText("Expired");
  await expect(page.getByTestId(`handoff-request-${"d".repeat(43)}`).getByRole("button", { name: "Reconcile approval" })).toHaveCount(0);
  await expect(page.getByTestId(`handoff-request-${"e".repeat(43)}`).getByRole("button", { name: "Reconcile approval" })).toHaveCount(0);
});

const catalogFixture = {
  contractVersion: "doppelganger.marketplace.agent-action-catalog.v1",
  workspaceSlug: "default",
  actions: [
    { pluginId: "github-composio", pluginName: "GitHub", provider: "github", actionKey: "github.create.issue", label: "Create issue", description: "Open an issue in a repository.", capability: "connector.dispatch", resourceKind: "github.connected-account", mode: "connected-account", accounts: [{ accountId: "ca_1" }], allowedArguments: ["body", "owner", "repo", "title"], toolName: "GITHUB_CREATE_ISSUE" },
    { pluginId: "github-composio", pluginName: "GitHub", provider: "github", actionKey: "github.list.repositories", label: "List repositories", description: "", capability: "connector.observe", resourceKind: "github.connected-account", mode: "connected-account", accounts: [{ accountId: "ca_1" }], allowedArguments: ["page", "per_page"], toolName: "GITHUB_LIST_REPOSITORIES" },
    { pluginId: "slack-composio", pluginName: "Slack", provider: "slack", actionKey: "slack.list.channels", label: "List channels", description: "", capability: "connector.observe", resourceKind: "slack.connected-account", mode: "connected-account", accounts: [{ accountId: "ca_slack_a", label: "Acme" }, { accountId: "ca_slack_b", label: "Beta" }], allowedArguments: null, toolName: "SLACK_LIST_CHANNELS" },
  ],
};

async function routeActionCatalog(page: import("@playwright/test").Page, body: unknown = catalogFixture) {
  await page.route("**/api/marketplace/v1/agent/action-catalog?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

function emptyGrants() {
  return {
    contractVersion: "doppelganger.marketplace.agent-connector-grant.v1",
    workspaceSlug: "default",
    grants: [],
    handoffRequests: [],
    consents: [],
    handoffContractVersion: "tealbrick.marketplace.operator-handoff.v1.1",
    grantCreation: { available: false, code: "portal_handoff_required", detail: "Direct creation is disabled." },
  };
}

test("picks a published dispatch action, explains its access level, and sends the catalog selection", async ({ page }) => {
  let requestBody: Record<string, unknown> | null = null;
  await page.route("**/api/marketplace/agent/grants?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyGrants()) });
  });
  await routeActionCatalog(page);
  await page.route("**/api/marketplace/v1/agent/grants/request", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, schema: 1, error: "agent_action_not_published" }) });
  });

  await unlockMarketplace(page);
  await page.getByRole("button", { name: "Agent grants" }).click();
  await expect(page.getByLabel("Action", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Request approval in Portal" })).toBeDisabled();
  await page.getByText("Developer details").click();
  await page.getByLabel("Portal deployment ID").fill("deployment-1");
  await page.getByLabel("Agent selection").fill("agent-1");

  // Two accounts: nothing is auto-selected until the operator picks one.
  await page.getByLabel("Connector").selectOption("slack-composio");
  await expect(page.getByLabel("Action", { exact: true })).toHaveValue("slack.list.channels");
  await expect(page.getByLabel("Connected account")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Request approval in Portal" })).toBeDisabled();
  await page.getByLabel("Connected account").selectOption("ca_slack_b");
  await expect(page.getByLabel("Resource scope")).toHaveValue("account:ca_slack_b");

  await page.getByLabel("Connector").selectOption("github-composio");
  await page.getByLabel("Action", { exact: true }).selectOption("github.create.issue");
  await expect(page.getByLabel("Connected account")).toHaveValue("ca_1");
  await expect(page.getByTestId("grant-capability")).toContainText("Can make changes");
  await expect(page.getByTestId("grant-capability")).toContainText("create and update items");
  await page.getByRole("button", { name: "Request approval in Portal" }).click();
  await expect(page.getByText("This action isn't available to agents right now")).toBeVisible();
  expect(requestBody).toMatchObject({
    deploymentId: "deployment-1",
    agentId: "agent-1",
    selection: { pluginId: "github-composio", actionKey: "github.create.issue", accountId: "ca_1", resourceKind: "github.connected-account", resourceRef: "account:ca_1" },
  });
});

test("shows the empty state when no connector publishes agent actions", async ({ page }) => {
  await page.route("**/api/marketplace/agent/grants?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyGrants()) });
  });
  // No catalog route: the fixture server has nothing installed or connected.
  await unlockMarketplace(page);
  await page.getByRole("button", { name: "Agent grants" }).click();
  await expect(page.getByRole("heading", { name: "Install and connect a connector first" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request approval in Portal" })).toBeDisabled();
  await page.getByRole("button", { name: "Browse the catalog" }).click();
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();
});

function selectionForFixture(accountId: string) {
  return { pluginId: "github-composio", actionKey: "github.list.repositories", accountId, resourceKind: "github.connected-account", resourceRef: `account:${accountId}` };
}
