// Small parsers for Unicode Character Database files, shared by the generate-*.ts scripts. Version-exact: nothing
// here uses the runtime's own Unicode tables (String.prototype.normalize, toLowerCase, \p{...}), because Node's ICU
// can be a Unicode version behind the data files.
//
// Every input is pinned (Unicode version + sha256, below): a missing file, a different file, a version mismatch, an
// empty parse result or an entry count under its floor throws, so a generator never writes an empty or partial table.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const UNICODE_VERSION = "18.0.0";

export type UcdPin = {
  name: string;
  sha256: string;
  /** Captures the version from the file's own header; UnicodeData.txt has none (its sha256 pins it). */
  versionPattern?: RegExp;
};

/** The exact Unicode 18.0.0 files the committed tables were generated from (https://www.unicode.org/Public/18.0.0/). */
export const PINS = {
  confusables: {
    name: "confusables.txt",
    sha256: "6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92",
    versionPattern: /^# Version: (\S+)$/mu,
  },
  caseFolding: {
    name: "CaseFolding.txt",
    sha256: "a004797658a457bec4dc11683e39f69249ea3b595b752dbea6721c4c9f587b0d",
    versionPattern: /^# CaseFolding-(\S+)\.txt$/mu,
  },
  unicodeData: { name: "UnicodeData.txt", sha256: "0736451de439ae7baf1425136617da495e09ee5afbe6e394374db7009ea08950" },
  derivedCoreProperties: {
    name: "DerivedCoreProperties.txt",
    sha256: "09c928886a178fcafd93c29e4bd59073a058e5a100b716d425cb563ab50f68c9",
    versionPattern: /^# DerivedCoreProperties-(\S+)\.txt$/mu,
  },
} as const satisfies Record<string, UcdPin>;

export type UcdFile = { text: string; sha256: string; version: string };

/** Reads a pinned input; throws on a missing file, a sha256 or version mismatch, or an empty file. */
export function readUcd(file: string | undefined, pin: UcdPin): UcdFile {
  if (!file) throw new Error(`${pin.name}: no path given`);
  if (!existsSync(file)) throw new Error(`${pin.name}: file not found: ${file}`);
  const text = readFileSync(file, "utf8");
  if (!text.trim()) throw new Error(`${pin.name}: file is empty: ${file}`);
  const sha256 = createHash("sha256").update(text).digest("hex");
  if (sha256 !== pin.sha256) throw new Error(`${pin.name}: sha256 ${sha256} is not the pinned ${pin.sha256} (Unicode ${UNICODE_VERSION}): ${file}`);
  if (pin.versionPattern) {
    const version = pin.versionPattern.exec(text)?.[1];
    if (version !== UNICODE_VERSION) throw new Error(`${pin.name}: version ${version ?? "(none found)"} is not the pinned ${UNICODE_VERSION}: ${file}`);
  }
  return { text, sha256, version: UNICODE_VERSION };
}

/** Throws when a parsed table is smaller than its floor (the pinned file's count; never 0). */
export function assertFloor(label: string, count: number, floor: number): void {
  if (floor < 1) throw new Error(`${label}: floor must be at least 1`);
  if (count < floor) throw new Error(`${label}: ${count} entries, expected at least ${floor} (Unicode ${UNICODE_VERSION})`);
}

const cps = (hex: string) => hex.trim().split(/\s+/u).filter(Boolean).map((part) => Number.parseInt(part, 16));

/** CaseFolding.txt statuses C and F: the full case folding (multi-character folds included). */
export function fullCaseFolding(text: string): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const line of text.split("\n")) {
    const body = line.split("#")[0]?.trim();
    if (!body) continue;
    const [code, status, mapping] = body.split(";").map((part) => part.trim());
    if (!code || !mapping || (status !== "C" && status !== "F")) continue;
    out.set(Number.parseInt(code, 16), cps(mapping));
  }
  return out;
}

export type UnicodeData = {
  /** General_Category per listed code point (range entries expanded only for categories we query, see `category`). */
  category: (code: number) => string | undefined;
  /** Mn code points as inclusive ranges, merged. */
  mnRanges: Array<[number, number]>;
  /** Decomposition_Mapping per code point; `compat` is true for tagged (<font>, <circle>, ...) mappings. */
  decomposition: Map<number, { compat: boolean; mapping: number[] }>;
  /** Simple_Lowercase_Mapping (field 13) per code point that has one. */
  lowercase: Map<number, number>;
  codes: number[];
};

export function parseUnicodeData(text: string): UnicodeData {
  const single = new Map<number, string>();
  const ranges: Array<[number, number, string]> = [];
  const decomposition = new Map<number, { compat: boolean; mapping: number[] }>();
  const lowercase = new Map<number, number>();
  const codes: number[] = [];
  let rangeStart: number | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split(";");
    const code = Number.parseInt(fields[0]!, 16);
    const name = fields[1] ?? "";
    const gc = fields[2] ?? "";
    if (name.endsWith(", First>")) {
      rangeStart = code;
      continue;
    }
    if (name.endsWith(", Last>") && rangeStart !== undefined) {
      ranges.push([rangeStart, code, gc]);
      rangeStart = undefined;
      continue;
    }
    single.set(code, gc);
    codes.push(code);
    const decomp = (fields[5] ?? "").trim();
    if (decomp) {
      const compat = decomp.startsWith("<");
      decomposition.set(code, { compat, mapping: cps(compat ? decomp.replace(/^<[^>]+>/u, "") : decomp) });
    }
    const lower = (fields[13] ?? "").trim();
    if (lower) lowercase.set(code, Number.parseInt(lower, 16));
  }
  const mnRanges: Array<[number, number]> = [];
  for (const code of codes) {
    if (single.get(code) !== "Mn") continue;
    const last = mnRanges.at(-1);
    if (last && last[1] === code - 1) last[1] = code;
    else mnRanges.push([code, code]);
  }
  const category = (code: number) => single.get(code) ?? ranges.find(([from, to]) => code >= from && code <= to)?.[2];
  return { category, mnRanges, decomposition, lowercase, codes };
}

/** Full decomposition (NFKD when `compat`, NFD otherwise) without canonical reordering (callers only strip marks). */
export function decompose(data: UnicodeData, codes: number[], compat: boolean): number[] {
  const out: number[] = [];
  for (const code of codes) {
    const entry = data.decomposition.get(code);
    if (entry && (compat || !entry.compat)) out.push(...decompose(data, entry.mapping, compat));
    else out.push(code);
  }
  return out;
}

export const escapeCodes = (codes: number[]) => codes.map((code) => `\\u{${code.toString(16)}}`).join("");

/** Items joined with `,` and emitted as a string concatenation of lines at most ~`width` characters wide. */
export function packedLiteral(items: string[], width = 110): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const next = line ? `${line},${item}` : item;
    if (next.length > width && line) {
      lines.push(`${line},`);
      line = item;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.map((part) => `  "${part}"`).join(" +\n");
}

/** A code point's characters as a lowercase term (ASCII letters/digits), or undefined. */
export function asTerm(codes: number[]): string | undefined {
  const text = String.fromCodePoint(...codes);
  return codes.length > 0 && /^[A-Za-z0-9]+$/u.test(text) ? text.toLowerCase() : undefined;
}

const NONSPACING: ReadonlySet<string> = new Set(["Mn"]);
/** General_Category=M (Mn, Mc, Me): the UCD equivalent of the regex class \p{M}. */
export const ALL_MARKS: ReadonlySet<string> = new Set(["Mn", "Mc", "Me"]);

/** Canonical decomposition, then the given mark categories (default General_Category=Mn) removed. */
export function stripMarks(data: UnicodeData, codes: number[], marks: ReadonlySet<string> = NONSPACING): number[] {
  return decompose(data, codes, false).filter((code) => !marks.has(data.category(code) ?? ""));
}

/**
 * Code points whose compatibility decomposition reads as term characters: `strict` when the NFKD itself is a string of
 * ASCII letters/digits, `marked` when it becomes one only after mark removal and full case folding.
 */
export function compatTermReadings(data: UnicodeData, folding: Map<number, number[]>): { strict: Array<[number, string]>; marked: Array<[number, string]> } {
  const strict: Array<[number, string]> = [];
  const marked: Array<[number, string]> = [];
  const fold = (codes: number[]) => codes.flatMap((code) => folding.get(code) ?? [code]);
  for (const code of data.codes) {
    if (!data.decomposition.has(code)) continue;
    const nfkd = decompose(data, [code], true);
    const exact = asTerm(nfkd);
    if (exact) {
      strict.push([code, exact]);
      continue;
    }
    const loose = asTerm(stripMarks(data, fold(stripMarks(data, nfkd))));
    if (loose) marked.push([code, loose]);
  }
  return { strict, marked };
}
