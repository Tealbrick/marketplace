import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const baseURL = "http://127.0.0.1:55314";

export default defineConfig({
  testDir: path.join(webRoot, "e2e"),
  testIgnore: "**/handoff.spec.ts",
  globalSetup: path.join(webRoot, "e2e", "global-setup.ts"),
  outputDir: path.join(webRoot, "test-results"),
  reporter: [["html", { outputFolder: path.join(webRoot, "playwright-report"), open: "never" }], ["list"]],
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
