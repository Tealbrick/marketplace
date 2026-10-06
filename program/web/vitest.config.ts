import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    // @tealbrick/ui imports its brand SVG; let Vite transform it for component tests.
    server: { deps: { inline: ["@tealbrick/ui"] } },
  },
});
