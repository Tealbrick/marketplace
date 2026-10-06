/**
 * Composio toolkit coverage: every method of the upstream API (vendored
 * `<toolkit>.api-methods.json`, with discovery-document provenance) maps to
 * at least one tool of the vendored Composio tool snapshot
 * (`<toolkit>.tools.json`), or is listed under `unmapped` with a reason.
 * Tools that map to no upstream method are listed as extras. The toolkit's
 * policy patterns must each match a real tool, so a typo can never leave a
 * tool ungoverned.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  composioPatternMatches,
  composioPolicyFor,
  ComposioPolicySchema,
  composioToolPolicy,
  type ComposioPolicy,
} from "./composio-policy.js";
import { inferConnectorCapabilityFromAction, normalizeComposioTools } from "./connectors.js";
import type { ConnectorCapability } from "./types.js";

export const DEFAULT_COMPOSIO_POLICY_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "catalog",
  "composio-policy",
);

const ToolsSnapshotSchema = z.object({
  schema: z.literal(1),
  toolkit: z.string(),
  capturedAt: z.string(),
  source: z.string(),
  tools: z.array(z.object({ slug: z.string().min(1), name: z.string().optional(), hints: z.array(z.string()).default([]) }).passthrough()),
});

const ApiMethodsSchema = z.object({
  schema: z.literal(1),
  toolkit: z.string(),
  api: z.string(),
  provenance: z.object({ discovery: z.string().url(), revision: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/u) }).passthrough(),
  methods: z.array(
    z.object({ id: z.string().min(1), httpMethod: z.string(), path: z.string(), tools: z.array(z.string().min(1)).optional() }).strict(),
  ),
  unmapped: z.array(z.object({ method: z.string(), reason: z.string().optional() }).strict()).default([]),
});

export type ComposioMethodItem = {
  method: string;
  httpMethod: string;
  path: string;
  status: "mapped" | "unmapped" | "failed";
  tools: string[];
  reason?: string;
};

export type ComposioToolItem = {
  slug: string;
  capability: ConnectorCapability;
  outward: "always" | "unlessQuiet" | null;
  destructive: boolean;
  methods: string[];
};

export type ComposioToolkitCoverage = {
  toolkit: string;
  api: string;
  revision: string;
  policyVersion: string;
  methods: number;
  mapped: number;
  unmapped: number;
  tools: number;
  extras: string[];
  ok: boolean;
  errors: string[];
  warnings: string[];
  items: ComposioMethodItem[];
  toolItems: ComposioToolItem[];
};

export type ComposioCoverageReport = {
  schema: 1;
  ok: boolean;
  toolkits: ComposioToolkitCoverage[];
  loadErrors: Array<{ toolkit: string; message: string }>;
};

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function toolkitCoverage(dir: string, toolkit: string, policy: ComposioPolicy): ComposioToolkitCoverage {
  const errors: string[] = [];
  const warnings: string[] = [];
  const snapshot = ToolsSnapshotSchema.parse(readJson(path.join(dir, `${toolkit}.tools.json`)));
  const api = ApiMethodsSchema.parse(readJson(path.join(dir, `${toolkit}.api-methods.json`)));
  if (snapshot.toolkit !== toolkit || api.toolkit !== toolkit) errors.push("Snapshot or method list names another toolkit.");
  if (!composioPolicyFor(toolkit)) errors.push(`Policy ${toolkit}.json is not registered in src/composio-policy.ts.`);
  else if (JSON.stringify(composioPolicyFor(toolkit)) !== JSON.stringify(policy)) {
    errors.push("The bundled policy differs from the catalog file; rebuild.");
  }
  const slugs = new Set(snapshot.tools.map((tool) => tool.slug));
  if (slugs.size !== snapshot.tools.length) errors.push("The tool snapshot lists a slug twice.");
  const unmapped = new Map(api.unmapped.map((entry) => [entry.method, entry.reason]));
  const seen = new Set<string>();
  const items: ComposioMethodItem[] = api.methods.map((method) => {
    if (seen.has(method.id)) errors.push(`Method ${method.id} is listed twice.`);
    seen.add(method.id);
    const tools = method.tools ?? [];
    const base = { method: method.id, httpMethod: method.httpMethod, path: method.path, tools };
    const missing = tools.filter((slug) => !slugs.has(slug));
    if (missing.length) {
      errors.push(`${method.id} maps to tools missing from the snapshot: ${missing.join(", ")}.`);
      return { ...base, status: "failed" as const, reason: "tool missing from snapshot" };
    }
    if (unmapped.has(method.id)) {
      const reason = unmapped.get(method.id)?.trim();
      if (tools.length) errors.push(`${method.id} is both mapped and unmapped.`);
      if (!reason) {
        errors.push(`Unmapped method ${method.id} has no reason.`);
        return { ...base, status: "failed" as const };
      }
      return { ...base, status: "unmapped" as const, reason };
    }
    if (!tools.length) {
      errors.push(`${method.id} maps to no tool and is not listed as unmapped.`);
      return { ...base, status: "failed" as const, reason: "no tool" };
    }
    return { ...base, status: "mapped" as const };
  });
  for (const method of unmapped.keys()) {
    if (!seen.has(method)) errors.push(`Unmapped method ${method} is not in the API method list.`);
  }
  const patterns: Array<[string, readonly string[]]> = [
    ["outward.always", policy.outward.always],
    ["outward.unlessQuiet", policy.outward.unlessQuiet],
    ["destructive", policy.destructive],
    ["writes", policy.writes],
    ["reads", policy.reads],
  ];
  for (const [kind, list] of patterns) {
    for (const pattern of list) {
      if (![...slugs].some((slug) => composioPatternMatches(pattern, slug))) {
        errors.push(`${kind} pattern "${pattern}" matches no tool in the snapshot.`);
      }
    }
  }
  const methodsByTool = new Map<string, string[]>();
  for (const item of items) for (const slug of item.tools) methodsByTool.set(slug, [...(methodsByTool.get(slug) ?? []), item.method]);
  const toolItems: ComposioToolItem[] = snapshot.tools.map((tool) => {
    // Classify with the policy file under review (the bundled copy must match it, checked above).
    const [normalized] = normalizeComposioTools(toolkit, [{ slug: tool.slug }]);
    const governed = composioToolPolicy(policy, tool.slug, inferConnectorCapabilityFromAction(normalized!.action));
    const capability = governed.capability;
    if (tool.hints.includes("destructiveHint") && capability !== "connector.admin" && !policy.destructive.some((pattern) => composioPatternMatches(pattern, tool.slug))) {
      warnings.push(`${tool.slug} carries destructiveHint but is classified ${capability}.`);
    }
    if (!tool.hints.includes("readOnlyHint") && capability === "connector.observe") {
      errors.push(`${tool.slug} is not read-only upstream but classifies as connector.observe; add it to writes.`);
    }
    return {
      slug: tool.slug,
      capability,
      outward: governed.outward,
      destructive: governed.destructive,
      methods: methodsByTool.get(tool.slug) ?? [],
    };
  });
  return {
    toolkit,
    api: api.api,
    revision: api.provenance.revision,
    policyVersion: policy.version,
    methods: items.length,
    mapped: items.filter((item) => item.status === "mapped").length,
    unmapped: items.filter((item) => item.status === "unmapped").length,
    tools: snapshot.tools.length,
    extras: toolItems.filter((tool) => !tool.methods.length).map((tool) => tool.slug),
    ok: errors.length === 0,
    errors,
    warnings,
    items,
    toolItems,
  };
}

export function composioCoverageReport(dir: string = DEFAULT_COMPOSIO_POLICY_DIR): ComposioCoverageReport {
  const toolkits: ComposioToolkitCoverage[] = [];
  const loadErrors: ComposioCoverageReport["loadErrors"] = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  for (const file of files) {
    if (!/^[a-z0-9_-]+\.json$/u.test(file) || file === "coverage.json") continue;
    const toolkit = file.slice(0, -".json".length);
    try {
      const policy = ComposioPolicySchema.parse(readJson(path.join(dir, file)));
      if (policy.toolkit !== toolkit) throw new Error(`${file} declares toolkit ${policy.toolkit}.`);
      toolkits.push(toolkitCoverage(dir, toolkit, policy));
    } catch (error) {
      loadErrors.push({
        toolkit,
        message:
          error instanceof z.ZodError
            ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }
  return { schema: 1, ok: loadErrors.length === 0 && toolkits.every((toolkit) => toolkit.ok), toolkits, loadErrors };
}

function cell(value: string) {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

export function composioCoverageMarkdown(report: ComposioCoverageReport) {
  const lines = [
    "# Composio toolkit coverage",
    "",
    "Generated by `pnpm run composio:coverage`. Do not edit by hand.",
    "",
    `Status: **${report.ok ? "pass" : "FAIL"}**.`,
    "",
    "| Toolkit | API | Revision | Methods mapped | Unmapped (with reason) | Tools | Extras | Policy | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.toolkits.map(
      (toolkit) =>
        `| \`${toolkit.toolkit}\` | ${cell(toolkit.api)} | ${toolkit.revision} | ${toolkit.mapped}/${toolkit.methods} | ${toolkit.unmapped} | ${toolkit.tools} | ${toolkit.extras.length} | ${toolkit.policyVersion} | ${toolkit.ok ? "pass" : "FAIL"} |`,
    ),
    "",
  ];
  for (const error of report.loadErrors) lines.push(`- **${error.toolkit}** could not load: ${cell(error.message)}`);
  for (const toolkit of report.toolkits) {
    lines.push(`## \`${toolkit.toolkit}\``, "");
    for (const error of toolkit.errors) lines.push(`- Error: ${cell(error)}`);
    for (const warning of toolkit.warnings) lines.push(`- Warning: ${cell(warning)}`);
    if (toolkit.errors.length || toolkit.warnings.length) lines.push("");
    lines.push("| Upstream method | HTTP | Tools | Status |", "| --- | --- | --- | --- |");
    for (const item of toolkit.items) {
      lines.push(
        `| \`${item.method}\` | ${item.httpMethod} ${cell(item.path)} | ${item.tools.map((tool) => `\`${tool}\``).join(", ") || "—"} | ${item.status}${item.reason ? `: ${cell(item.reason)}` : ""} |`,
      );
    }
    lines.push("", "| Tool | Capability | Outward | Destructive | Upstream methods |", "| --- | --- | --- | --- | --- |");
    for (const tool of toolkit.toolItems) {
      lines.push(
        `| \`${tool.slug}\` | ${tool.capability} | ${tool.outward === "always" ? "always" : tool.outward === "unlessQuiet" ? "unless quiet" : ""} | ${tool.destructive ? "yes" : ""} | ${tool.methods.join(", ") || "extra"} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** CLI: `composio:coverage [--dir <policy dir>] [--no-write]`. Returns the exit code. */
export function runComposioCoverageCli(argv: readonly string[], defaults: { dir: string }, log: (line: string) => void = console.log) {
  let dir = defaults.dir;
  let write = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dir") dir = path.resolve(argv[++index] ?? "");
    else if (arg === "--no-write") write = false;
    else {
      log(`Unknown argument ${arg}. Usage: composio:coverage [--dir <policy dir>] [--no-write]`);
      return 2;
    }
  }
  const report = composioCoverageReport(dir);
  if (write) {
    fs.writeFileSync(path.join(dir, "coverage.json"), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, "COVERAGE.md"), composioCoverageMarkdown(report));
  }
  for (const toolkit of report.toolkits) {
    log(`${toolkit.ok ? "ok  " : "FAIL"} ${toolkit.toolkit}: ${toolkit.mapped}/${toolkit.methods} methods mapped, ${toolkit.unmapped} unmapped, ${toolkit.extras.length} extra tools`);
    for (const error of toolkit.errors) log(`     error: ${error}`);
  }
  for (const error of report.loadErrors) log(`FAIL ${error.toolkit}: ${error.message}`);
  log(report.ok ? "Composio coverage passed." : "Composio coverage FAILED.");
  return report.ok ? 0 : 1;
}
