import { describe, expect, it } from "vitest";

import { CASE_FOLDING_SIZE, CASE_FOLDING_VERSION } from "./case-folding-data.js";
import { COMPAT_MARKED, COMPAT_MARKED_SIZE, COMPAT_READINGS_VERSION, COMPAT_STRICT, COMPAT_STRICT_SIZE } from "./compat-readings-data.js";
import { UTS39_SKELETON, UTS39_SKELETON_SIZE, UTS39_SUBSET_SIZE, UTS39_VERSION } from "./confusables-data.js";
import { fullCaseFold } from "./confusables.js";
import { DEFAULT_IGNORABLE_RANGES } from "./default-ignorables-data.js";
import { forbiddenTermsIn } from "./sessions.js";
import { CASE_FOLD_CORPUS, CASE_FOLD_CORPUS_SIZE, MN_RANGES, MN_SIZE, UNICODE_CORPUS_VERSION } from "./unicode-corpus-data.js";

const hex = (code: number) => `U+${code.toString(16).toUpperCase()}`;
/** "source:target,..." (source in hex) → [code point, ASCII target]. */
const unpack = (packed: string): Array<[number, string]> =>
  packed.split(",").map((entry) => {
    const [from, to] = entry.split(":");
    return [Number.parseInt(from!, 16), to!];
  });

/** Code points whose character, standing in for `target` inside a term, does not match that term. */
function standInMisses(corpus: Array<[number, string]>): string[] {
  const misses: string[] = [];
  for (const [code, target] of corpus) {
    if (forbiddenTermsIn(`qz${String.fromCodePoint(code)}zq`, [`qz${target}zq`]).length !== 1) misses.push(`${hex(code)}→${target}`);
  }
  return misses;
}

// Authoritative corpora (Unicode data files, generated — not hand lists) for the forbidden-term matcher.
// "Term characters" are ASCII letters and digits (case-insensitive); "mark removal" removes General_Category=Mn after
// canonical decomposition. All data is Unicode 18.0.0; the runtime's own tables may be older and are not trusted.
describe("forbidden-term matcher against Unicode data", () => {
  it("uses one Unicode version for every generated table", () => {
    expect([UTS39_VERSION, CASE_FOLDING_VERSION, COMPAT_READINGS_VERSION, UNICODE_CORPUS_VERSION]).toEqual(["18.0.0", "18.0.0", "18.0.0", "18.0.0"]);
    expect(CASE_FOLDING_SIZE).toBeGreaterThanOrEqual(1606);
  });

  // UTS #39 subset criterion: every confusables.txt mapping with a single-code-point source whose prototype, after
  // mark removal and full case folding, consists only of ASCII letters/digits; ASCII sources only when the prototype
  // differs from their folded form. The generator counts the subset (UTS39_SUBSET_SIZE) and the emitted keys with
  // lowercase aliases (UTS39_SKELETON_SIZE) from confusables.txt itself; the floors are the 18.0.0 counts, so a new
  // Unicode version or a generator change cannot shrink the subset silently.
  it("keeps the whole UTS #39 subset (stored counts and floors)", () => {
    expect(Object.keys(UTS39_SKELETON).length).toBe(UTS39_SKELETON_SIZE);
    expect(UTS39_SUBSET_SIZE).toBeGreaterThanOrEqual(2065);
    expect(UTS39_SKELETON_SIZE).toBeGreaterThanOrEqual(2171);
    expect(UTS39_SKELETON_SIZE).toBeGreaterThanOrEqual(UTS39_SUBSET_SIZE);
  });

  it("applies every UTS #39 confusable mapping in the generated subset", () => {
    const misses: string[] = [];
    for (const [source, prototype] of Object.entries(UTS39_SKELETON)) {
      const term = `qz${prototype}zq`;
      if (forbiddenTermsIn(`qz${source}zq`, [term]).length !== 1) misses.push(hex(source.codePointAt(0)!));
    }
    expect(misses).toEqual([]);
  });

  it("ignores every Default_Ignorable_Code_Point inserted inside a term", () => {
    const misses: string[] = [];
    for (const [from, to] of DEFAULT_IGNORABLE_RANGES) {
      for (let code = from; code <= to; code += 1) {
        const char = String.fromCodePoint(code);
        if (forbiddenTermsIn(`se${char}cret`, ["secret"]).length !== 1) misses.push(hex(code));
      }
    }
    expect(misses).toEqual([]);
  });

  it("ignores every General_Category=Mn code point inserted inside a term", () => {
    const misses: string[] = [];
    let size = 0;
    for (const [from, to] of MN_RANGES) {
      for (let code = from; code <= to; code += 1) {
        size += 1;
        const char = String.fromCodePoint(code);
        if (forbiddenTermsIn(`se${char}cret`, ["secret"]).length !== 1) misses.push(hex(code));
      }
    }
    expect(size).toBe(MN_SIZE);
    expect(size).toBe(2090);
    expect(misses).toEqual([]);
  });

  // Criterion: every code point with a CaseFolding.txt C or F folding whose folded result, after mark removal,
  // consists only of term characters. U+0149 (ŉ → U+02BC n) and U+1E9A (ẚ → a U+02BE) fold to a modifier letter,
  // which is not a term character, so they are outside the criterion.
  it("matches every code point standing in for its full case folding inside a term", () => {
    const corpus = unpack(CASE_FOLD_CORPUS);
    expect(corpus.length).toBe(CASE_FOLD_CORPUS_SIZE);
    expect(corpus.length).toBe(287);
    expect(corpus).toEqual(expect.arrayContaining([[0x1e9e, "ss"], [0xdf, "ss"], [0x212a, "k"], [0x212b, "a"], [0x1df95, "ss"], [0xfb06, "st"]]));
    expect(standInMisses(corpus)).toEqual([]);
  });

  it("applies full case folding to terms and text (not only toLowerCase)", () => {
    expect(fullCaseFold("STRAẞE \u{1DF95} ŉ")).toBe("strasse ss ʼn");
    // A term written with a capital sharp s (toLowerCase keeps "ß") matches the folded spelling, and vice versa.
    expect(forbiddenTermsIn("strasse", ["STRAẞE"])).toEqual(["STRAẞE"]);
    expect(forbiddenTermsIn("STRAẞE", ["strasse"])).toEqual(["strasse"]);
    // UTS #39 prototype U+00DF folds to "ss": these sources were outside the lowercased subset (misses before).
    for (const char of ["\u{3B2}", "\u{A7D6}", "\u{A7D7}", "\u{13F0}"]) expect(forbiddenTermsIn(`cla${char}ified`, ["classified"]), hex(char.codePointAt(0)!)).toEqual(["classified"]);
    // U+1DF95 (folds to "ss"; unassigned in a Unicode 17 runtime) as text and as term.
    expect(forbiddenTermsIn("cla\u{1DF95}ified", ["classified"])).toEqual(["classified"]);
    expect(forbiddenTermsIn("classified", ["cla\u{1DF95}ified"])).toEqual(["cla\u{1DF95}ified"]);
    // Latin small beta keeps both readings: UTS #39 (sharp s → "ss") and its capital's "b".
    expect(forbiddenTermsIn("\u{A7B5}et", ["bet"])).toEqual(["bet"]);
    expect(forbiddenTermsIn("\u{A7B5}et", ["sset"])).toEqual(["sset"]);
  });

  // Unicode 18 case pairs (UnicodeData.txt field 13): U+1DF6A -> U+1DF6B (UTS #39: A) and U+1DF6E -> U+1DF6F (UTS #39:
  // l + U+0335). A Unicode 17 runtime has no lowercase mapping for them, so a lowercase alias built with toLowerCase
  // was missing and "d\u{1DF6B}t\u{1DF6B}" did not match "data" (bypass before the generator used UnicodeData.txt).
  it("reads Unicode 18 small letters like their capitals (case pairs the runtime does not know)", () => {
    expect(UTS39_SKELETON["\u{1DF6B}"]).toBe("a");
    expect(UTS39_SKELETON["\u{1DF6F}"]).toBe("l");
    expect(forbiddenTermsIn("d\u{1DF6B}t\u{1DF6B}", ["data"])).toEqual(["data"]);
    expect(forbiddenTermsIn("D\u{1DF6A}T\u{1DF6A}", ["data"])).toEqual(["data"]);
    expect(forbiddenTermsIn("\u{1DF6F}eak", ["leak"])).toEqual(["leak"]);
    expect(forbiddenTermsIn("\u{1DF6E}eak", ["leak"])).toEqual(["leak"]);
    // Term side: a term written with the small letter matches the plain spelling.
    expect(forbiddenTermsIn("data", ["d\u{1DF6B}t\u{1DF6B}"])).toEqual(["d\u{1DF6B}t\u{1DF6B}"]);
  });

  // Criterion: every code point with a Decomposition_Mapping whose full compatibility decomposition (NFKD, i.e. the
  // NFKC form) is a string of term characters, standing in for that string inside a term.
  it("matches every code point whose NFKC form is a string of term characters", () => {
    const corpus = unpack(COMPAT_STRICT);
    expect(corpus.length).toBe(COMPAT_STRICT_SIZE);
    expect(corpus.length).toBe(1225);
    expect(corpus).toEqual(expect.arrayContaining([[0xfb03, "ffi"], [0x216b, "xii"], [0x2469, "10"], [0x1d400, "a"], [0xff21, "a"], [0x209d, "w"]]));
    expect(standInMisses(corpus)).toEqual([]);
  });

  // The generated readings feed the matcher directly, so the corpus above also checks wiring. This cross-check keeps
  // the table honest against the runtime: wherever the runtime knows the character, its own NFKC (marks removed,
  // folded) must give the same reading; the table may differ only for code points the runtime has unassigned (Cn),
  // e.g. U+209D..U+209F (subscript w, y, z; new in Unicode 18) under an ICU with Unicode 17 data, a real miss before.
  it("agrees with the runtime NFKC wherever the runtime knows the character", () => {
    const runtimeReading = (char: string) => fullCaseFold(char.normalize("NFKD").replace(/\p{Mn}/gu, "").toLowerCase()).normalize("NFD").replace(/\p{Mn}/gu, "");
    const disagreements: string[] = [];
    for (const [code, target] of [...unpack(COMPAT_STRICT), ...unpack(COMPAT_MARKED)]) {
      const char = String.fromCodePoint(code);
      if (runtimeReading(char) !== target && !/\p{Cn}/u.test(char)) disagreements.push(`${hex(code)}→${target}`);
    }
    expect(disagreements).toEqual([]);
    // Term side too: a term written with such a character matches its plain spelling.
    expect(forbiddenTermsIn("wire", ["\u{209D}ire"])).toEqual(["\u{209D}ire"]);
    expect(forbiddenTermsIn("\u{209D}ire", ["wire"])).toEqual(["wire"]);
  });

  // The rest of the compatibility and canonical decompositions: NFKD becomes a string of term characters after mark
  // removal and full case folding (é → e, ǅ → dz).
  it("matches every code point whose NFKC form reads as term characters after mark removal and folding", () => {
    const corpus = unpack(COMPAT_MARKED);
    expect(corpus.length).toBe(COMPAT_MARKED_SIZE);
    expect(corpus.length).toBe(495);
    expect(corpus).toEqual(expect.arrayContaining([[0xe9, "e"], [0x1c5, "dz"]]));
    expect(standInMisses(corpus)).toEqual([]);
  });
});
