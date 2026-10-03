import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const webRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.join(webRoot, "e2e"),
  testMatch: "handoff.spec.ts",
  globalSetup: path.join(webRoot, "e2e", "handoff-global-setup.ts"),
  outputDir: path.join(webRoot, "test-results-handoff"),
  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: "http://127.0.0.1:55314",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
