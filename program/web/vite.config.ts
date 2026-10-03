import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const localSdk = path.resolve(here, "../../.sdk/doppelganger-ui");
const deployedSdk = path.resolve(here, "../../.sdk/doppelganger-ui");
const sdkRoot = process.env.DOPPELGANGER_UI_SDK_ROOT
  ?? (fs.existsSync(path.join(deployedSdk, "src", "fleet.css")) ? deployedSdk : localSdk);
const programOrigin = process.env.MARKETPLACE_PROGRAM_ORIGIN ?? "http://127.0.0.1:5314";

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^@doppelganger\/ui\/tokens\.css$/u, replacement: path.join(sdkRoot, "src/tokens.css") },
      { find: /^@doppelganger\/ui\/components\.css$/u, replacement: path.join(sdkRoot, "src/components.css") },
      { find: /^@doppelganger\/ui\/fleet\.css$/u, replacement: path.join(sdkRoot, "src/fleet.css") },
      { find: /^@doppelganger\/ui$/u, replacement: path.join(sdkRoot, "src/index.tsx") },
    ],
  },
  build: { outDir: path.resolve(here, "../web-dist"), emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5414,
    fs: { allow: [path.resolve(here, ".."), sdkRoot] },
    proxy: {
      "/api": programOrigin,
      "/bootstrap.json": programOrigin,
      "/openapi.json": programOrigin,
      "/swagger.json": programOrigin,
      "/status": programOrigin,
    },
  },
});
