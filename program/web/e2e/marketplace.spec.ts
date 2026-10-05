import { expect, test } from "@playwright/test";

async function assertNoViewportOverflow(page: import("@playwright/test").Page) {
  await expect.poll(() => page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }))).toEqual(expect.objectContaining({ documentWidth: expect.any(Number), viewportWidth: expect.any(Number) }));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function assertContained(locator: import("@playwright/test").Locator, viewport: { width: number; height: number }) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function unlockMarketplace(page: import("@playwright/test").Page, route = "/") {
  await page.goto(route);
  await expect(page.getByRole("heading", { name: "Open Marketplace from Teal Brick Portal" })).toBeVisible();
  await page.getByText("Operator recovery").click();
  await page.getByLabel("Operator access token").fill("marketplace-e2e-operator-token");
  await page.getByRole("button", { name: "Unlock Marketplace" }).click();
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();
}

for (const viewport of [
  { label: "wide", width: 1152, height: 820 },
  { label: "tablet", width: 820, height: 900 },
  { label: "phone", width: 390, height: 844 },
]) {
  test(`${viewport.label} standalone, settings, and controls stay contained`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await unlockMarketplace(page);
    await expect(page.locator(".catalog-row").first()).toBeVisible();
    await expect(page.locator(".plugin-workspace, .detail-empty")).toBeVisible();
    await assertNoViewportOverflow(page);
    for (const name of ["Catalog", "Installed", "Connections", "Agent grants", "Activity"]) {
      await assertContained(page.getByRole("navigation").getByRole("button", { name }), viewport);
    }

    const supportedRow = page.locator(".catalog-row").filter({ hasText: "Composio" }).first();
    await expect(supportedRow).toBeVisible();
    await supportedRow.click();
    const installButton = page.getByRole("button", { name: "Install", exact: true });
    await expect(installButton).toBeEnabled();
    await installButton.click();
    const confirm = page.getByRole("dialog", { name: /Install .+\?/u });
    await expect(confirm).toBeVisible();
    await assertContained(confirm, viewport);
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Install", exact: true })).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Open settings" }).last().click();
    const modal = page.getByRole("dialog", { name: "Settings" });
    await expect(modal).toBeVisible();
    await assertContained(modal, viewport);
    await modal.getByRole("tab", { name: "Developer" }).click();
    await expect(modal.getByText("Developer contract")).toBeVisible();
    await assertNoViewportOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`${viewport.label}-settings.png`), fullPage: true });
    await modal.getByRole("tab", { name: "Security" }).click();
    await expect(modal.getByText("marketplace-e2e-operator")).toBeVisible();
    await modal.getByRole("button", { name: "Close settings" }).click();
  });
}

test("embed renders independently and catalog search is server-backed", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/marketplace/cards/summary")) requests.push(request.url());
  });
  await unlockMarketplace(page, "/embed");
  await page.getByRole("textbox", { name: "Search catalog" }).fill("definitely absent capability");
  await expect(page.getByText("No matching capabilities.")).toBeVisible();
  expect(requests.some((url) => url.includes("search=definitely+absent+capability"))).toBe(true);
  await assertNoViewportOverflow(page);
});

test("embed works inside a same-origin host iframe with the operator session", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await unlockMarketplace(page);
  await page.goto("/healthz");
  await page.evaluate(() => {
    document.body.innerHTML = '<iframe title="Marketplace host frame" src="/embed" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>';
  });
  const frame = page.frameLocator('iframe[title="Marketplace host frame"]');
  await expect(frame.getByRole("heading", { name: "Discover" })).toBeVisible();
  const geometry = await frame.locator("html").evaluate((element) => ({
    width: element.scrollWidth,
    viewport: element.clientWidth,
  }));
  expect(geometry.width - geometry.viewport).toBeLessThanOrEqual(1);
});

test("customer copy: Rules outage, catalog-only listing, and session expiry", async ({ page, context }) => {
  await page.setViewportSize({ width: 1152, height: 820 });
  await unlockMarketplace(page);
  // This fixture runs in owner approval mode (no Rules). Simulate the
  // rules-mode outage response (configured Rules unreachable) for the copy check.
  await page.route("**/api/marketplace/plugins/*/install", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ ok: false, error: "rules_unavailable", governedCapability: "connector.admin", detail: "Rules Approvals is required for connector admin, dispatch, generation, and execution." }),
  }));

  await page.locator(".catalog-row").filter({ hasText: "Composio" }).first().click();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: /Install .+\?/u });
  await confirm.getByRole("button", { name: "Install", exact: true }).click();
  await expect(confirm.getByRole("alert")).toContainText("Approvals are unavailable right now");
  await expect(confirm).not.toContainText("Rules Approvals is required");
  await confirm.getByRole("button", { name: "Cancel" }).click();

  const listedOnly = page.locator(".catalog-row").filter({ hasText: "Listed — not yet installable" }).first();
  await expect(listedOnly).toBeVisible();
  await listedOnly.click();
  await expect(page.getByRole("button", { name: "Install", exact: true })).toBeDisabled();
  await expect(page.locator(".action-tooltip").first()).toHaveAttribute("title", /Only Composio connectors and your own custom connectors can be installed today/u);
  await expect(page.locator("body")).not.toContainText("CatalogOnly");
  await expect(page.locator("body")).not.toContainText("bearer");

  await context.clearCookies();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("heading", { name: "Your session ended" })).toBeVisible();
  await expect(page.getByText("Your session ended — relaunch Marketplace from Teal Brick Portal.")).toBeVisible();
  await expect(page.getByText("Operator recovery")).toBeVisible();
});

test("real health indicators and the Installed empty state", async ({ page }) => {
  await page.setViewportSize({ width: 1152, height: 820 });
  const healthRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/healthz" || url.pathname === "/api/marketplace/health") healthRequests.push(url.pathname);
  });
  await unlockMarketplace(page);
  const topbar = page.locator(".topbar");
  await expect(topbar.getByText("Online", { exact: true })).toBeVisible();
  // No Rules client in this fixture: owner approval mode, not a blocked state.
  await expect(topbar.getByText("Rules not connected — owner approval mode")).toBeVisible();
  await expect(page.locator(".rules-status-row")).toContainText("owner approval mode");
  await expect(page.locator("body")).not.toContainText("can't be approved");
  expect(healthRequests).toEqual(expect.arrayContaining(["/healthz", "/api/marketplace/health"]));
  await expect(page.locator("body")).not.toContainText("Program online");

  await page.getByRole("navigation").getByRole("button", { name: "Installed" }).click();
  await expect(page.getByRole("heading", { name: "Nothing installed yet" })).toBeVisible();
  await page.getByRole("button", { name: "Browse the catalog" }).click();
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();

  await page.getByRole("button", { name: "Open settings" }).last().click();
  const modal = page.getByRole("dialog", { name: "Settings" });
  await modal.getByRole("tab", { name: "Authorization" }).click();
  await expect(modal.getByLabel("Service status")).toContainText("Rules not connected — owner approval mode");
  await expect(modal.getByLabel("Service status")).toContainText("You approve installs and actions yourself. Agents can only act with consent you grant in Teal Brick Portal.");
  await expect(modal.getByText("Technical details")).toBeVisible();
});

test("Composio key settings: empty state copy, bad key, save, and remove", async ({ page }) => {
  await page.setViewportSize({ width: 1152, height: 820 });
  await unlockMarketplace(page);
  await page.getByRole("button", { name: "Open settings" }).last().click();
  const modal = page.getByRole("dialog", { name: "Settings" });
  const status = modal.getByTestId("composio-key-status");
  await expect(status).toContainText("No API key yet");
  await expect(modal).not.toContainText("fingerprint —");
  await expect(modal).not.toContainText("Source: none");
  await expect(modal.getByRole("button", { name: "Test key" })).toBeDisabled();

  const keyInput = modal.getByLabel("API key", { exact: true });
  await keyInput.fill("not a valid key");
  await modal.getByRole("button", { name: "Save", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("That API key doesn't look right");

  await keyInput.fill("e2e_fixture_key_9876");
  await modal.getByRole("button", { name: "Save", exact: true }).click();
  await expect(status).toContainText("API key ending in …9876");
  await expect(status).toContainText("saved in Marketplace");

  await modal.getByRole("button", { name: "Remove key" }).click();
  await modal.getByRole("button", { name: "Confirm removal" }).click();
  await expect(modal.getByText("API key removed.")).toBeVisible();
  await expect(status).toContainText("No API key yet");
});

test("phone header Refresh is a visible, centred icon control", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await unlockMarketplace(page);
  const refresh = page.locator("header.topbar").getByRole("button", { name: "Refresh" });
  await expect(refresh).toBeVisible();
  const button = await refresh.boundingBox();
  const icon = await refresh.locator("svg").boundingBox();
  expect(button).not.toBeNull();
  expect(icon).not.toBeNull();
  // Square icon control, not an empty or text-width box.
  expect(Math.abs(button!.width - button!.height)).toBeLessThanOrEqual(2);
  expect(icon!.width).toBeGreaterThanOrEqual(12);
  expect(Math.abs(icon!.x + icon!.width / 2 - (button!.x + button!.width / 2))).toBeLessThanOrEqual(1.5);
  expect(Math.abs(icon!.y + icon!.height / 2 - (button!.y + button!.height / 2))).toBeLessThanOrEqual(1.5);
  // The icon is drawn in a colour that differs from the button background.
  const colours = await refresh.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: getComputedStyle(element.querySelector("svg")!).color, background: style.backgroundColor };
  });
  expect(colours.color).not.toBe(colours.background);
});
