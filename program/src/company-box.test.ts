import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { companyBoxListing, loadCompanyBoxCatalog, searchAgentOperations } from "./company-box.js";
import {
  companyBoxCoverageMarkdown,
  companyBoxCoverageReport,
  runCompanyBoxCoverageCli,
} from "./company-box-coverage.js";
import { sha256Hex } from "./openapi-adapter.js";

const FIXTURES = path.join(import.meta.dirname, "testing", "company-box");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Copy the fixture catalog and patch one entry.json (and optionally its spec). */
function catalogWith(
  patch: { entry?: string; change?: (entry: Record<string, unknown>) => void; spec?: (spec: Record<string, unknown>) => void } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "company-box-catalog-"));
  roots.push(root);
  cpSync(FIXTURES, root, { recursive: true });
  if (patch.entry) {
    const entryPath = path.join(root, patch.entry, "entry.json");
    const entry = JSON.parse(readFileSync(entryPath, "utf8")) as Record<string, unknown>;
    if (patch.spec) {
      const openapi = entry.openapi as { spec: string; sha256: string };
      const specPath = path.join(root, patch.entry, openapi.spec);
      const spec = JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
      patch.spec(spec);
      const text = JSON.stringify(spec);
      writeFileSync(specPath, text);
      openapi.sha256 = sha256Hex(text);
    }
    patch.change?.(entry);
    writeFileSync(entryPath, JSON.stringify(entry, null, 2));
  }
  return root;
}

describe("Company Box catalog", () => {
  it("compiles the fixture entries with automatic exposure modes", () => {
    const catalog = loadCompanyBoxCatalog(FIXTURES);
    expect(catalog.loadErrors).toEqual([]);
    expect(catalog.entries.map((entry) => [entry.entry.id, entry.kind, entry.exposure, entry.errors])).toEqual([
      ["bigapp", "openapi", "discovery", []],
      ["notes", "openapi", "direct", []],
      ["tracker", "mcp", "direct", []],
    ]);
    expect(loadCompanyBoxCatalog(FIXTURES, { directMaxOperations: 500 }).get("bigapp")?.exposure).toBe("direct");
    const notes = catalog.openApiForPluginId("company-box-notes")!;
    const listing = companyBoxListing(notes);
    expect(listing).toMatchObject({
      pluginId: "company-box-notes",
      provider: "company-box-notes",
      source: "openapi",
      executionOwner: "openapi",
      capabilities: ["connector.observe", "connector.dispatch", "connector.admin"],
    });
    expect(listing.actions).toHaveLength(10);
    expect(listing.actions).not.toContain("company-box-notes.reindex-all");
    expect(JSON.stringify(listing.manifest)).not.toContain("$defs");
    expect(notes.byKey.get("company-box-notes.share-note")).toMatchObject({ outward: true, capability: "connector.dispatch" });
    expect(notes.byKey.get("company-box-notes.delete-note")).toMatchObject({ destructive: true, capability: "connector.admin" });
  });

  it("paginates search instead of truncating", () => {
    const bigapp = loadCompanyBoxCatalog(FIXTURES).openApiForPluginId("company-box-bigapp")!;
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = searchAgentOperations(bigapp.operations, { cursor, limit: 40 });
      expect(page.total).toBe(152);
      seen.push(...page.operations.map((operation) => operation.key));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(152);
    expect(searchAgentOperations(bigapp.operations, { query: "publish res07" }).operations.map((operation) => operation.key)).toEqual([
      "company-box-bigapp.publish-res07",
    ]);
    expect(searchAgentOperations(bigapp.operations, { tag: "publishing" }).total).toBe(25);
    expect(searchAgentOperations(bigapp.operations, { capability: "connector.admin" }).total).toBe(25);
  });
});

describe("Company Box coverage", () => {
  it("passes for the fixtures and reports every operation", () => {
    const report = companyBoxCoverageReport(FIXTURES);
    expect(report.ok).toBe(true);
    expect(report.totals).toEqual({ entries: 3, operations: 167, exposed: 165, excluded: 2 });
    expect(report.entries.map((entry) => [entry.id, entry.exposed, entry.excluded, entry.total, entry.outward])).toEqual([
      ["bigapp", 152, 0, 152, 25],
      ["notes", 10, 1, 11, 1],
      ["tracker", 3, 1, 4, 1],
    ]);
    const markdown = companyBoxCoverageMarkdown(report);
    expect(markdown).toContain("| Notes (`notes`) | openapi | 2.4.0 | 10/11 | 1 | direct | 1 | 1 | pass |");
    expect(markdown).toContain("| reindexAll | excluded | Maintenance job");
    expect(markdown).toContain("| Tracker (`tracker`) | mcp | 1.0.0 | 3/4 | 1 | direct |");
  });

  it("fails when an exclusion has no reason or names no operation", () => {
    const missingReason = catalogWith({ entry: "notes", change: (entry) => (entry.excluded = [{ operation: "reindexAll" }]) });
    const report = companyBoxCoverageReport(missingReason);
    expect(report.ok).toBe(false);
    expect(report.entries.find((entry) => entry.id === "notes")!.errors).toEqual(['Exclusion "reindexAll" has no reason.']);

    const unknown = catalogWith({
      entry: "tracker",
      change: (entry) => (entry.excluded = [...(entry.excluded as object[]), { operation: "nope", reason: "gone" }]),
    });
    expect(companyBoxCoverageReport(unknown).entries.find((entry) => entry.id === "tracker")!.errors).toEqual([
      'Exclusion "nope" matches no operation in the pinned spec.',
    ]);
  });

  it("fails when a spec operation cannot be exposed or the pin drifts", () => {
    const brokenRef = catalogWith({
      entry: "notes",
      spec: (spec) => {
        const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
        paths["/folders"]!.get!.parameters = [{ name: "q", in: "query", schema: { $ref: "#/components/schemas/Missing" } }];
      },
    });
    const report = companyBoxCoverageReport(brokenRef);
    const notes = report.entries.find((entry) => entry.id === "notes")!;
    expect(report.ok).toBe(false);
    expect(notes).toMatchObject({ exposed: 9, excluded: 1, failed: 1, total: 11 });
    expect(notes.errors).toContain("Exposed (9) + excluded (1) must equal the 11 operations in the pinned spec.");

    const drift = catalogWith({ entry: "notes", change: (entry) => ((entry.openapi as { sha256: string }).sha256 = "0".repeat(64)) });
    const drifted = companyBoxCoverageReport(drift);
    expect(drifted.ok).toBe(false);
    expect(drifted.loadErrors).toEqual([
      expect.objectContaining({ entry: "notes", code: "company_box_entry_unreadable", message: expect.stringContaining("pinned sha256") }),
    ]);
  });

  it("requires a safe GET health operation", () => {
    const root = catalogWith({ entry: "notes", change: (entry) => (entry.healthOperation = "createNote") });
    expect(companyBoxCoverageReport(root).entries.find((entry) => entry.id === "notes")!.errors).toEqual([
      'healthOperation "createNote" must be a GET operation.',
    ]);
  });

  it("CLI writes coverage.json + COVERAGE.md and exits non-zero on gaps", () => {
    const passing = catalogWith();
    const lines: string[] = [];
    expect(runCompanyBoxCoverageCli([], { dir: passing }, (line) => lines.push(line))).toBe(0);
    expect(lines.at(-1)).toBe("Coverage passed: 165/167 operations exposed across 3 entries.");
    expect(readFileSync(path.join(passing, "COVERAGE.md"), "utf8")).toContain("Status: **pass**");
    expect(JSON.parse(readFileSync(path.join(passing, "coverage.json"), "utf8"))).toMatchObject({ ok: true });

    const failing = catalogWith({ entry: "notes", change: (entry) => (entry.excluded = [{ operation: "reindexAll", reason: " " }]) });
    expect(runCompanyBoxCoverageCli(["--dir", failing, "--no-write"], { dir: passing }, () => undefined)).toBe(1);
    expect(runCompanyBoxCoverageCli(["--bogus"], { dir: passing }, () => undefined)).toBe(2);
  });
});
