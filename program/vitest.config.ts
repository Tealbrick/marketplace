import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The Company Box agent-path suites drive thousands of operations in parallel workers; keep the small time-sensitive tests from flaking when the machine is saturated.
    testTimeout: 30_000,
  },
});
