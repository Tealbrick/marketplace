import { describe, expect, it } from "vitest";

import { UTS39_SKELETON } from "./confusables-data.js";
import { DEFAULT_IGNORABLE_RANGES } from "./default-ignorables-data.js";
import { forbiddenTermsIn } from "./sessions.js";

// Authoritative corpora (Unicode data files, generated — not hand lists) for the forbidden-term matcher.
describe("forbidden-term matcher against Unicode data", () => {
  it("applies every UTS #39 confusable mapping in the generated subset", () => {
    const misses: string[] = [];
    for (const [source, prototype] of Object.entries(UTS39_SKELETON)) {
      const term = `qz${prototype}zq`;
      if (forbiddenTermsIn(`qz${source}zq`, [term]).length !== 1) misses.push(`U+${source.codePointAt(0)!.toString(16)}`);
    }
    expect(misses).toEqual([]);
  });

  it("ignores every Default_Ignorable_Code_Point inserted inside a term", () => {
    const misses: string[] = [];
    for (const [from, to] of DEFAULT_IGNORABLE_RANGES) {
      for (let code = from; code <= to; code += 1) {
        const char = String.fromCodePoint(code);
        if (forbiddenTermsIn(`se${char}cret`, ["secret"]).length !== 1) misses.push(`U+${code.toString(16)}`);
      }
    }
    expect(misses).toEqual([]);
  });
});
