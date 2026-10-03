import { build } from "esbuild";
import path from "node:path";

const programRoot = path.resolve(import.meta.dirname, "..");

await build({
  entryPoints: [path.join(programRoot, "src", "index.ts")],
  outfile: path.join(programRoot, "dist", "marketplace-program.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});
