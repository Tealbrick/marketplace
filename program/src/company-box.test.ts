import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { companyBoxListing, companyBoxMcpToolRisk, loadCompanyBoxCatalog, searchAgentOperations } from "./company-box.js";
import {
  companyBoxCoverageMarkdown,
  companyBoxCoverageReport,
  runCompanyBoxCoverageCli,
} from "./company-box-coverage.js";
import { policyCheckedLookup } from "./mcp-url-policy.js";
import { sha256Hex } from "./openapi-adapter.js";
import { SqliteMarketplaceStore } from "./store.js";
import { boundedStoredOutput, outputDigest } from "./usage-ledger.js";

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

  it("applies reads patterns to entries and MCP tools, and warns on unmatched ones", () => {
    const root = catalogWith({ entry: "notes", change: (entry) => (entry.reads = ["createFolder", "nothingMatches*"]) });
    const notes = loadCompanyBoxCatalog(root).openApiForPluginId("company-box-notes")!;
    expect(notes.byKey.get("company-box-notes.create-folder")).toMatchObject({ capability: "connector.observe", write: false, outward: false });
    expect(notes.warnings).toContain('reads pattern "nothingMatches*" matches no operation.');
    expect(notes.byKey.get("company-box-notes.create-folder")?.group).toBe("folders");
    const entry = { outward: [], destructive: [], reads: ["search_*"] };
    expect(companyBoxMcpToolRisk(entry, { name: "search_issues", annotations: { readOnlyHint: false } }, "search-issues")).toMatchObject({ capability: "connector.observe", write: false });
    expect(companyBoxMcpToolRisk(entry, { name: "create_issue" }, "create-issue")).toMatchObject({ capability: "connector.dispatch" });
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

describe("stored output bounds", () => {
  it("keeps outputs up to 64 KB and a size + sha256 marker beyond", () => {
    const small = { ok: true };
    expect(boundedStoredOutput(small)).toMatchObject({ output: small, truncated: false, bytes: 11 });
    const large = { text: "z".repeat(70_000) };
    const bounded = boundedStoredOutput(large);
    expect(bounded.truncated).toBe(true);
    expect(bounded.output).toEqual({ truncated: true, bytes: outputDigest(large).bytes, sha256: outputDigest(large).sha256 });

    const root = mkdtempSync(path.join(os.tmpdir(), "company-box-approval-store-"));
    roots.push(root);
    const store = new SqliteMarketplaceStore(path.join(root, "m.sqlite"));
    try {
      const approval = store.createCompanyBoxApproval({
        workspaceSlug: "ws",
        pluginId: "company-box-notes",
        actionKey: "company-box-notes.share-note",
        capability: "connector.dispatch",
        agentId: "agent-1",
        sourceKind: "agent-grant",
        sourceRef: "grant-1",
        idempotencyKey: null,
        fingerprint: "f",
        arguments: { path: { id: "1" } },
        argumentsPreview: "{}",
        ttlMs: 60_000,
      });
      expect(store.decideCompanyBoxApproval({ id: approval.id, workspaceSlug: "other", decision: "approve", decidedBy: "x" })).toBeNull();
      expect(store.decideCompanyBoxApproval({ id: approval.id, workspaceSlug: "ws", decision: "approve", decidedBy: "owner" })?.state).toBe("executing");
      expect(store.decideCompanyBoxApproval({ id: approval.id, workspaceSlug: "ws", decision: "approve", decidedBy: "owner" })).toBeNull();
      const finished = store.finishCompanyBoxApproval({ id: approval.id, state: "succeeded", result: large });
      expect(finished.result).toEqual({ truncated: true, bytes: outputDigest(large).bytes, sha256: outputDigest(large).sha256 });
    } finally {
      store.close();
    }
  });
});

describe("engine requests from the entries pass", () => {
  it("drops declared credential parameters and keeps undeclared path params as required strings", () => {
    const root = catalogWith({
      entry: "notes",
      spec: (spec) => {
        const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
        paths["/folders"]!.get!.parameters = [{ name: "authorization", in: "header", schema: { type: "string" } }];
        paths["/folders/{folderId}/notes"] = { get: { operationId: "listFolderNotes", responses: { 200: { description: "ok" } } } };
      },
    });
    const notes = loadCompanyBoxCatalog(root).openApiForPluginId("company-box-notes")!;
    expect(notes.byKey.get("company-box-notes.list-folders")!.operation.parameters).toEqual([]);
    expect(notes.warnings).toContain("1 declared credential parameter(s) dropped; Marketplace sets the credential itself.");
    expect(notes.byKey.get("company-box-notes.list-folder-notes")!.operation.parameters).toEqual([
      { name: "folderId", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  it("auto-excludes GET operations with a request body", () => {
    const root = catalogWith({
      entry: "notes",
      spec: (spec) => {
        const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
        paths["/search"] = {
          get: {
            operationId: "searchWithBody",
            requestBody: { content: { "application/json": { schema: { type: "object" } } } },
            responses: { 200: { description: "ok" } },
          },
        };
      },
    });
    const report = companyBoxCoverageReport(root);
    const notes = report.entries.find((entry) => entry.id === "notes")!;
    expect(notes).toMatchObject({ ok: true, total: 12, exposed: 10, excluded: 2 });
    expect(notes.items.find((item) => item.ref === "searchWithBody")).toMatchObject({ status: "excluded", auto: true, reason: expect.stringMatching(/^auto: /u) });
  });

  it("applies a pinned JSON merge patch overlay before parsing", () => {
    const root = catalogWith({ entry: "notes" });
    const overlay = JSON.stringify({ paths: { "/folders": { get: { summary: "Folder tree (overlay)", tags: ["library"] } }, "/admin/reindex": null } });
    writeFileSync(path.join(root, "notes", "overlay.json"), overlay);
    const entryPath = path.join(root, "notes", "entry.json");
    const entry = JSON.parse(readFileSync(entryPath, "utf8"));
    entry.openapi.overlay = { file: "overlay.json", sha256: sha256Hex(overlay) };
    entry.excluded = [];
    writeFileSync(entryPath, JSON.stringify(entry));
    const notes = loadCompanyBoxCatalog(root).openApiForPluginId("company-box-notes")!;
    expect(notes.errors).toEqual([]);
    expect(notes.byKey.get("company-box-notes.list-folders")).toMatchObject({ title: "Folder tree (overlay)", group: "library" });
    expect(notes.coverage).toHaveLength(10);
    entry.openapi.overlay.sha256 = "0".repeat(64);
    writeFileSync(entryPath, JSON.stringify(entry));
    expect(loadCompanyBoxCatalog(root).loadErrors[0]).toMatchObject({ entry: "notes", message: expect.stringContaining("pinned sha256") });
  });
});

describe("DNS pinning", () => {
  it("re-checks every resolved address at connect time", async () => {
    const run = (answers: Array<{ address: string; family: number }>, all: boolean) =>
      new Promise<{ error: unknown; address: unknown }>((resolve) =>
        policyCheckedLookup(async () => answers)("app.example.com", { all }, (error, address) => resolve({ error, address })),
      );
    expect(await run([{ address: "93.184.216.34", family: 4 }], false)).toEqual({ error: null, address: "93.184.216.34" });
    expect(await run([{ address: "93.184.216.34", family: 4 }], true)).toEqual({ error: null, address: [{ address: "93.184.216.34", family: 4 }] });
    for (const rebound of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1"]) {
      const result = await run([{ address: "93.184.216.34", family: 4 }, { address: rebound, family: rebound.includes(":") ? 6 : 4 }], true);
      expect(result.error).toMatchObject({ code: "EADDRNOTAVAIL" });
    }
    expect((await run([{ address: "100.88.1.2", family: 4 }], false)).error).toBeNull();
  });
});
