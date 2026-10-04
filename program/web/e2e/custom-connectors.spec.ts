import { expect, test } from "@playwright/test";

import { CUSTOM_CONNECTORS_BASE_URL, E2E_MCP_PORT, E2E_MCP_SECRET } from "./fixtures";

// This fixture runs with an allow-all Rules client and a fake remote MCP
// server on loopback (allowlisted through MARKETPLACE_MCP_ALLOWED_ORIGINS).
test.use({ baseURL: CUSTOM_CONNECTORS_BASE_URL });

async function unlockMarketplace(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Marketplace from Teal Brick Portal" })).toBeVisible();
  await page.getByText("Operator recovery").click();
  await page.getByLabel("Operator access token").fill("marketplace-e2e-operator-token");
  await page.getByRole("button", { name: "Unlock Marketplace" }).click();
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();
}

test("custom connector: add, refresh tools, edit the secret, and delete", async ({ page }) => {
  await page.setViewportSize({ width: 1152, height: 820 });
  await unlockMarketplace(page);
  await page.getByRole("navigation").getByRole("button", { name: "Connections" }).click();
  const section = page.getByRole("region", { name: "Custom connectors" });
  await expect(section.getByRole("heading", { name: "No custom connectors yet" })).toBeVisible();
  await expect(section).toContainText("https://");

  // Add
  await section.getByRole("button", { name: "Add connector" }).click();
  const addDialog = page.getByRole("dialog", { name: "Add an MCP server" });
  await expect(addDialog).toBeVisible();
  await addDialog.getByLabel("Name").fill("E2E Tracker");
  await addDialog.getByLabel("Server URL").fill(`http://127.0.0.1:${E2E_MCP_PORT}/mcp`);
  await expect(addDialog.getByLabel("Connection type")).toHaveValue("streamable-http");
  await addDialog.getByRole("button", { name: "Add header" }).click();
  await addDialog.getByLabel("Header name 1").fill("X-Api-Key");
  await addDialog.getByLabel("Secret header 1").check();
  await expect(addDialog.getByLabel("Header value 1")).toHaveAttribute("type", "password");
  await addDialog.getByLabel("Header value 1").fill(E2E_MCP_SECRET);
  await addDialog.getByRole("button", { name: "Add connector" }).click();
  await expect(addDialog).toBeHidden();
  await expect(section.getByRole("status")).toContainText("E2E Tracker added");

  const card = section.getByRole("article", { name: "E2E Tracker" });
  await expect(card).toContainText("Not loaded yet");
  await expect(card).toContainText("x-api-key (secret ·");

  // Refresh tools
  await card.getByRole("button", { name: "Refresh tools" }).click();
  await expect(card).toContainText("4 loaded");
  await expect(card.getByText("Echo", { exact: true })).toBeVisible();
  await expect(card.getByText("Read only").first()).toBeVisible();
  await expect(card.getByText("Admin / destructive")).toBeVisible();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("custom-connector-refreshed.png"), fullPage: true });

  // Edit: the saved secret is never prefilled; replace it with a wrong value.
  await card.getByRole("button", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit E2E Tracker" });
  await expect(editDialog).toContainText("Saved ·");
  await expect(editDialog.getByLabel("Server URL")).toHaveValue(`http://127.0.0.1:${E2E_MCP_PORT}/mcp`);
  await editDialog.getByRole("button", { name: "Replace" }).click();
  await editDialog.getByLabel("New value for x-api-key").fill("not-the-right-secret");
  await editDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(editDialog).toBeHidden();
  await expect(section.getByRole("status").first()).toContainText("E2E Tracker saved");

  await card.getByRole("button", { name: "Refresh tools" }).click();
  await expect(card).toContainText("Last refresh failed: The MCP server didn't accept the credentials");
  await expect(card.getByText("Blocked", { exact: true })).toBeVisible();

  // Secrets never reach the page.
  await expect(page.locator("body")).not.toContainText(E2E_MCP_SECRET);
  await expect(page.locator("body")).not.toContainText("not-the-right-secret");

  // Delete (two-step)
  await card.getByRole("button", { name: "Delete" }).click();
  await card.getByRole("button", { name: "Confirm delete" }).click();
  await expect(section.getByRole("heading", { name: "No custom connectors yet" })).toBeVisible();
});

test("custom connector form stays contained on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await unlockMarketplace(page);
  await page.getByRole("navigation").getByRole("button", { name: "Connections" }).click();
  const section = page.getByRole("region", { name: "Custom connectors" });
  await section.getByRole("button", { name: "Add connector" }).click();
  const dialog = page.getByRole("dialog", { name: "Add an MCP server" });
  await dialog.getByRole("button", { name: "Add header" }).click();
  await dialog.getByLabel("Secret header 1").check();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("phone-custom-connector-form.png") });
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("agent grants picker offers a refreshed custom connector's tools from the live catalog", async ({ page }) => {
  await page.setViewportSize({ width: 1152, height: 820 });
  await unlockMarketplace(page);
  // Create, refresh, and install through the operator session (same-origin + CSRF).
  const pluginId = await page.evaluate(async (input) => {
    const session = await (await fetch("/api/marketplace/auth/session")).json();
    const headers = { "content-type": "application/json", "x-csrf-token": session.session.csrfToken };
    const post = async (url: string, body: unknown) => {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`${url} -> ${response.status}`);
      return response.json();
    };
    const created = await post("/api/marketplace/connectors/custom", { displayName: "E2E Picker", url: input.url, transport: "streamable-http", secretHeaders: { "X-Api-Key": input.secret } });
    const id = created.connector.pluginId as string;
    await post(`/api/marketplace/connectors/custom/${id}/refresh`, {});
    await post(`/api/marketplace/plugins/${id}/install`, {});
    return id;
  }, { url: `http://127.0.0.1:${E2E_MCP_PORT}/mcp`, secret: E2E_MCP_SECRET });

  await page.getByRole("navigation").getByRole("button", { name: "Agent grants" }).click();
  await page.getByLabel("Connector").selectOption(pluginId);
  await page.getByLabel("Action", { exact: true }).selectOption(`${pluginId}.create-issue`);
  // Custom MCP connectors have one synthetic account: the connector itself.
  await expect(page.getByLabel("Connected account")).toHaveValue("connector");
  await expect(page.getByLabel("Connected account").locator("option:checked")).toHaveText("E2E Picker (connector)");
  await expect(page.getByLabel("Resource scope")).toHaveValue("account:connector");
  await expect(page.getByTestId("grant-capability")).toContainText("Can make changes");
  await page.getByLabel("Action", { exact: true }).selectOption(`${pluginId}.echo`);
  await expect(page.getByTestId("grant-capability")).toContainText("Read only");
  await expect(page.locator("body")).not.toContainText(E2E_MCP_SECRET);

  // Deleting the connector removes it from the picker.
  await page.evaluate(async (id) => {
    const session = await (await fetch("/api/marketplace/auth/session")).json();
    await fetch(`/api/marketplace/connectors/custom/${id}`, { method: "DELETE", headers: { "x-csrf-token": session.session.csrfToken } });
  }, pluginId);
  await page.getByRole("button", { name: "Refresh" }).first().click();
  await expect(page.getByRole("heading", { name: "Install and connect a connector first" })).toBeVisible();
});
