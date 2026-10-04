#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const marketplaceProgramDir = path.join(repoRoot, "extra", "microapps", "marketplace", "program");
// TEALBRICK_APP_HOME; DOPPELGANGER_APP_HOME is a deprecated alias.
if (!process.env.TEALBRICK_APP_HOME && process.env.DOPPELGANGER_APP_HOME) {
  console.warn("[marketplace] DOPPELGANGER_APP_HOME is deprecated; set TEALBRICK_APP_HOME instead.");
}
const defaultAppHome =
  process.env.TEALBRICK_APP_HOME ||
  process.env.DOPPELGANGER_APP_HOME ||
  process.env.T3CODE_HOME ||
  path.join(os.homedir(), ".t3");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function parseArgs(argv) {
  const options = {
    appHome: defaultAppHome,
    continueOnFailure: false,
    evidenceDir: path.join(os.tmpdir(), `tealbrick-plugin-pov-${timestamp()}`),
    skipLiveAppHome: false,
    skipProgramTests: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app-home") {
      options.appHome = argv.at(index + 1) ?? "";
      index += 1;
    } else if (arg === "--continue-on-failure") {
      options.continueOnFailure = true;
    } else if (arg === "--evidence-dir") {
      options.evidenceDir = argv.at(index + 1) ?? "";
      index += 1;
    } else if (arg === "--skip-live-app-home") {
      options.skipLiveAppHome = true;
    } else if (arg === "--skip-program-tests") {
      options.skipProgramTests = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node apps/marketplace/smoke/operator-pov-workflow.mjs [options]

Runs the Product plugin operator POV proof ladder and writes command evidence.

Options:
  --app-home <path>          Real App home for the live install rung. Default: ${defaultAppHome}
  --evidence-dir <path>      Directory for logs and summary JSON. Default: /tmp/tealbrick-plugin-pov-*
  --skip-live-app-home       Do not mutate/prove the real App-home marketplace install.
  --skip-program-tests       Skip Marketplace Program unit/typecheck rungs.
  --continue-on-failure      Keep running independent later rungs after a failure.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.appHome.trim()) {
    throw new Error("Missing App home.");
  }
  if (!options.evidenceDir.trim()) {
    throw new Error("Missing evidence directory.");
  }

  return {
    ...options,
    appHome: path.resolve(options.appHome),
    evidenceDir: path.resolve(options.evidenceDir),
  };
}

function commandToString(command, args) {
  return [command, ...args].map((part) => JSON.stringify(part)).join(" ");
}

async function runStep(step, evidenceDir) {
  const startedAt = new Date().toISOString();
  const commandText = commandToString(step.command, step.args);
  const logPath = path.join(evidenceDir, `${step.id}.log`);
  let stdout = "";
  let stderr = "";

  console.log(`\n[${step.id}] ${step.title}`);
  console.log(`$ ${commandText}`);

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: {
        ...process.env,
        // Steps may run other Micro-apps that only read the legacy name.
        TEALBRICK_DEBUG: "1",
        DOPPELGANGER_DEBUG: "1",
        ...step.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  const finishedAt = new Date().toISOString();
  await writeFile(
    logPath,
    [
      `# ${step.id}: ${step.title}`,
      `cwd: ${step.cwd}`,
      `command: ${commandText}`,
      `startedAt: ${startedAt}`,
      `finishedAt: ${finishedAt}`,
      `exitCode: ${exitCode}`,
      "",
      "## stdout",
      stdout,
      "",
      "## stderr",
      stderr,
    ].join("\n"),
  );

  return {
    id: step.id,
    title: step.title,
    cwd: step.cwd,
    command: commandText,
    logPath,
    startedAt,
    finishedAt,
    exitCode,
    ok: exitCode === 0,
  };
}

function buildSteps(options) {
  const steps = [
    {
      id: "00-microapp-contract",
      title: "Source Micro-app publish contract",
      command: "pnpm",
      args: ["--dir", "app", "validate:microapps"],
      cwd: repoRoot,
    },
  ];

  if (!options.skipProgramTests) {
    steps.push(
      {
        id: "10-marketplace-program-tests",
        title: "Marketplace Program unit tests",
        command: "pnpm",
        args: ["--dir", marketplaceProgramDir, "test"],
        cwd: repoRoot,
      },
      {
        id: "11-marketplace-program-typecheck",
        title: "Marketplace Program typecheck",
        command: "pnpm",
        args: ["--dir", marketplaceProgramDir, "typecheck"],
        cwd: repoRoot,
      },
    );
  }

  steps.push(
    {
      id: "20-source-agent-seam",
      title: "Level 1 source Agent-compatible seam",
      command: "pnpm",
      args: ["--dir", marketplaceProgramDir, "exec", "tsx", "../smoke/agent-natural-smoke.ts"],
      cwd: repoRoot,
    },
    {
      id: "30-temp-app-home",
      title: "Level 2 temporary App-home installed proof",
      command: "pnpm",
      args: ["--dir", marketplaceProgramDir, "exec", "tsx", "../smoke/installed-app-home-smoke.ts"],
      cwd: repoRoot,
    },
  );

  if (!options.skipLiveAppHome) {
    steps.push({
      id: "40-real-app-home",
      title: "Level 3 real App-home install and managed Program proof",
      command: "pnpm",
      args: [
        "--dir",
        marketplaceProgramDir,
        "smoke:live-app-home",
        "--",
        "--app-home",
        options.appHome,
      ],
      cwd: repoRoot,
    });
  }

  return steps;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.evidenceDir, { recursive: true });

  const summary = {
    ok: false,
    repoRoot,
    appHome: options.appHome,
    evidenceDir: options.evidenceDir,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    breakpoint: null,
    steps: [],
    nextHumanComputerUseChecks: [
      "Start or refresh the App backend so kernel.refreshRegistry sees the App-home registry.",
      "Open the App URL with browser/computer use and verify Settings > Extensions/Plugins shows the Marketplace/Teal Brick Marketplace package from the App-home registry.",
      "Open the Marketplace/Plugins surface and verify catalog, provider health, Agent capabilities, audit, and action-binding panels render from marketplace-api.",
      "For Composio-backed Gmail/Notion, verify auth popup launch, callback completion, connection state, capability binding, /api/agent/capabilities projection, and governed execution.",
    ],
  };

  for (const step of buildSteps(options)) {
    const result = await runStep(step, options.evidenceDir);
    summary.steps.push(result);
    await writeFile(
      path.join(options.evidenceDir, "summary.json"),
      `${JSON.stringify({ ...summary, ok: summary.steps.every((item) => item.ok) }, null, 2)}\n`,
    );

    if (!result.ok) {
      summary.breakpoint = {
        stepId: result.id,
        title: result.title,
        logPath: result.logPath,
      };
      if (!options.continueOnFailure) {
        break;
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  summary.ok = summary.steps.every((step) => step.ok);

  await writeFile(
    path.join(options.evidenceDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  console.log(`\nEvidence: ${options.evidenceDir}`);
  console.log(`Summary: ${path.join(options.evidenceDir, "summary.json")}`);

  if (!summary.ok) {
    console.error(
      `Workflow stopped at ${summary.breakpoint?.stepId ?? "unknown"}; see ${summary.breakpoint?.logPath ?? options.evidenceDir}.`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
