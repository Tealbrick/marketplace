import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 5490, strictPort: true },
  build: { outDir: "../gallery-dist", emptyOutDir: true },
});
