// Small parsers for Unicode Character Database files, shared by the generate-*.ts scripts. Version-exact: nothing
// here uses the runtime's own Unicode tables (String.prototype.normalize, toLowerCase, \p{...}), because Node's ICU
// can be a Unicode version behind the data files.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type UcdFile = { text: string; sha256: string; version: string };

export function readUcd(file: string, versionPattern: RegExp): UcdFile {
  const text = readFileSync(file, "utf8");
  return { text, sha256: createHash("sha256").update(text).digest("hex"), version: versionPattern.exec(text)?.[1] ?? "unknown" };
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
  codes: number[];
};

export function parseUnicodeData(text: string): UnicodeData {
  const single = new Map<number, string>();
  const ranges: Array<[number, number, string]> = [];
  const decomposition = new Map<number, { compat: boolean; mapping: number[] }>();
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
  }
  const mnRanges: Array<[number, number]> = [];
  for (const code of codes) {
    if (single.get(code) !== "Mn") continue;
    const last = mnRanges.at(-1);
    if (last && last[1] === code - 1) last[1] = code;
    else mnRanges.push([code, code]);
  }
  const category = (code: number) => single.get(code) ?? ranges.find(([from, to]) => code >= from && code <= to)?.[2];
  return { category, mnRanges, decomposition, codes };
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

/** Canonical decomposition, then General_Category=Mn removed. */
export function stripMarks(data: UnicodeData, codes: number[]): number[] {
  return decompose(data, codes, false).filter((code) => data.category(code) !== "Mn");
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
