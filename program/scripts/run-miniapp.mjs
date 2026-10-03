import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const programRoot = path.resolve(import.meta.dirname, "..");
const entrypoint = path.join(programRoot, "dist", "marketplace-program.mjs");

function runChecked(command, args) {
  const result = spawnSync(command, args, {
    cwd: programRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(entrypoint)) {
  runChecked("pnpm", ["install", "--ignore-scripts", "--offline"]);
  runChecked("pnpm", ["run", "build:miniapp"]);
}

const child = spawn(process.execPath, [entrypoint], {
  cwd: programRoot,
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
