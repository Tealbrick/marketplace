// Assistant-mode coverage: `pnpm run assistant-mode:coverage [--out <file>]`.
// Classifies every tool of the catalog snapshots in the repository (no network, no Composio key):
// the Composio snapshots in catalog/composio-policy/*.tools.json and the Company Box coverage
// (catalog/company-box/coverage.json), and writes docs/assistant-mode-coverage.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SENSITIVE_ACTION_FAMILIES, classifySensitive } from "../src/agent-approval-mode.js";
import { composioCallRisk, composioReviewedRead, composioToolClassification } from "../src/composio-policy.js";
import { inferConnectorCapabilityFromAction, normalizeComposioTools } from "../src/connectors.js";
import type { ConnectorCapability } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const programDir = path.resolve(here, "..");
const repoRoot = path.resolve(programDir, "..");
const outArg = process.argv.indexOf("--out");
const outFile = outArg > 0 ? path.resolve(process.argv[outArg + 1]!) : path.join(repoRoot, "docs/assistant-mode-coverage.md");

type Row = {
  source: string;
  slug: string;
  capability: ConnectorCapability;
  outward: boolean;
  klass: string;
  /** Why it is held or runs, for the reviewed table (curated flag, reviewed family, words). */
  basis: string;
};

const SUBSTRINGS = SENSITIVE_ACTION_FAMILIES.flatMap((family) =>
  family.words.map((word) => ({ family: family.family, word, needle: word.replace(/^\*_/u, "_").replace(/_\*$/u, "") })),
);

function classify(source: string, slug: string, toolkit: string | undefined, capability: ConnectorCapability, risk: { write: boolean; outward: boolean; destructive: boolean }, reviewedRead: boolean, reviewed?: string): Row {
  if (reviewedRead) return { source, slug, capability, outward: false, klass: "read-allowlisted", basis: "read allowlist" };
  if (!risk.outward) return { source, slug, capability, outward: false, klass: "not outward (consent only)", basis: "" };
  // The same order assistantHold applies (default family settings: every family ON), split by cause.
  if (risk.destructive) return { source, slug, capability, outward: true, klass: "held: destructive", basis: "curated destructive flag" };
  if (capability === "connector.admin") return { source, slug, capability, outward: true, klass: "held: admin", basis: "connector.admin" };
  if (reviewed) return { source, slug, capability, outward: true, klass: `held: sensitive:${reviewed}`, basis: "reviewed family" };
  const sensitive = classifySensitive(slug, { toolkit });
  return sensitive.sensitive
    ? { source, slug, capability, outward: true, klass: `held: sensitive:${sensitive.family}`, basis: `word ${sensitive.word}` }
    : { source, slug, capability, outward: true, klass: "assistant-runs", basis: "reviewed: runs" };
}

const rows: Row[] = [];

// Composio snapshots.
const policyDir = path.join(programDir, "catalog/composio-policy");
for (const file of fs.readdirSync(policyDir).filter((name) => name.endsWith(".tools.json")).sort()) {
  const snapshot = JSON.parse(fs.readFileSync(path.join(policyDir, file), "utf8")) as { toolkit: string; tools: Array<{ slug: string }> };
  const toolkit = snapshot.toolkit;
  for (const tool of snapshot.tools) {
    const normalized = normalizeComposioTools(toolkit, [{ slug: tool.slug }])[0]!;
    const inferred = inferConnectorCapabilityFromAction(normalized.action);
    const classification = composioToolClassification(toolkit, tool.slug, inferred);
    // Static view: a call without arguments (an "unless quiet" tool counts as outward).
    const risk = composioCallRisk(toolkit, tool.slug, undefined, inferred);
    rows.push(classify(`composio:${toolkit}${classification.curated ? " (curated)" : ""}`, tool.slug, toolkit, classification.capability, risk, composioReviewedRead(toolkit, tool.slug)));
  }
}

// Company Box entries (curated REST adapters and pinned MCP snapshots).
const coverage = JSON.parse(fs.readFileSync(path.join(programDir, "catalog/company-box/coverage.json"), "utf8")) as {
  entries: Array<{ id: string; source: string; items: Array<{ ref: string; status: string; capability?: ConnectorCapability; outward?: boolean; destructive?: boolean; sensitiveFamily?: string }> }>;
};
for (const entry of coverage.entries) {
  for (const item of entry.items) {
    if (item.status !== "exposed" || !item.capability) continue;
    const risk = { write: item.capability !== "connector.observe", outward: item.outward === true, destructive: item.destructive === true };
    rows.push(classify(`company-box:${entry.id} (${entry.source})`, item.ref, undefined, item.capability, risk, false, item.sensitiveFamily));
  }
}

const classes = ["read-allowlisted", "not outward (consent only)", "assistant-runs", "held: destructive", "held: admin", ...SENSITIVE_ACTION_FAMILIES.map((family) => `held: sensitive:${family.family}`)];
const sources = [...new Set(rows.map((row) => row.source))];
const count = (source: string | null, klass: string) => rows.filter((row) => (source === null || row.source === source) && row.klass === klass).length;
const nearMisses = rows
  .filter((row) => row.klass === "assistant-runs")
  .map((row) => ({ row, hits: SUBSTRINGS.filter((entry) => row.slug.toUpperCase().includes(entry.needle)) }))
  .filter((entry) => entry.hits.length > 0);

const lines = [
  "# Assistant-mode coverage (generated)",
  "",
  "Generated by `pnpm --dir program run assistant-mode:coverage` (program/scripts/assistant-mode-coverage.ts). Do not edit by hand.",
  "",
  "Source: the catalog snapshots in this repository, no network. The only Composio snapshot is",
  "`program/catalog/composio-policy/googlecalendar.tools.json` (the curated toolkit). There is no snapshot of the full",
  "Composio catalog here; classifying uncurated toolkits tool by tool needs the live Composio catalog (a",
  "`COMPOSIO_API_KEY`), which this script does not use. Company Box rows come from `program/catalog/company-box/coverage.json`.",
  "",
  "Classes: `read-allowlisted` (reviewed read, uncurated Composio only; the allowlist ships empty); `not outward` (runs",
  "on the agent's consent in both modes, modes do not apply); `assistant-runs` (outward; held in System mode, runs at",
  "once in Assistant mode within the daily limits); `held: ...` (outward; held in both modes: curated destructive flag,",
  "`connector.admin`, a hand-reviewed family (Company Box entry.json `sensitiveFamilies`) or a word of a hold family;",
  "computed with the default family settings, every family ON).",
  "An \"unless quiet\" Calendar tool is counted as outward.",
  "",
  "## Counts",
  "",
  `| Source | Tools | ${classes.join(" | ")} |`,
  `| --- | ---: | ${classes.map(() => "---:").join(" | ")} |`,
  ...sources.map((source) => `| ${source} | ${rows.filter((row) => row.source === source).length} | ${classes.map((klass) => count(source, klass)).join(" | ")} |`),
  `| **All** | **${rows.length}** | ${classes.map((klass) => `**${count(null, klass)}**`).join(" | ")} |`,
  "",
  "## Near-misses: tools that run in Assistant mode and contain a sensitive word as a substring",
  "",
  "For manual review: the word matches only inside another word, so the tool is not held by name.",
  "",
  nearMisses.length ? "| Source | Tool | Substrings |" : "None.",
  ...(nearMisses.length ? ["| --- | --- | --- |"] : []),
  ...nearMisses.map(({ row, hits }) => `| ${row.source} | \`${row.slug}\` | ${[...new Set(hits.map((hit) => hit.word))].join(", ")} |`),
  "",
  "## Reviewed: every outward Company Box operation",
  "",
  "Each outward operation of the shipped entries was reviewed by hand. `held` rows wait for the owner in Assistant mode",
  "(System holds every row). Basis: the entry's curated destructive flag, `connector.admin`, a reviewed family",
  "(entry.json `sensitiveFamilies`), a tool-name word, or reviewed as runs.",
  "",
  "| Entry | Action | Assistant mode | Basis |",
  "| --- | --- | --- | --- |",
  ...rows
    .filter((row) => row.source.startsWith("company-box:") && row.outward)
    .map((row) => `| ${row.source.replace(/^company-box:/u, "").replace(/ \(openapi\)$/u, "")} | \`${row.slug}\` | ${row.klass === "assistant-runs" ? "runs" : row.klass.replace("held: sensitive:", "held: ")} | ${row.basis} |`),
  "",
];
fs.writeFileSync(outFile, `${lines.join("\n")}`);
console.log(`Wrote ${path.relative(repoRoot, outFile)}: ${rows.length} tools, ${count(null, "assistant-runs")} assistant-runs, ${nearMisses.length} near-misses.`);
