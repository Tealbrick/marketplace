import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { tealbrickAppIcons } from "@tealbrick/ui/vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const programOrigin = process.env.MARKETPLACE_PROGRAM_ORIGIN ?? "http://127.0.0.1:5314";

export default defineConfig({
  root: here,
  plugins: [react(), tealbrickAppIcons({ name: "Teal Brick Marketplace", shortName: "Marketplace" })],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  build: { outDir: path.resolve(here, "../web-dist"), emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5414,
    proxy: {
      "/api": programOrigin,
      "/bootstrap.json": programOrigin,
      "/openapi.json": programOrigin,
      "/swagger.json": programOrigin,
      "/status": programOrigin,
    },
  },
});
