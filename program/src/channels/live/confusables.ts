/**
 * Forbidden-term skeleton data (review of PR #53, M4).
 *
 * The base is generated from Unicode's UTS #39 `confusables.txt` (see confusables-data.ts for version and sha256;
 * regenerate with `pnpm exec tsx scripts/generate-confusables.ts <confusables.txt>`). The small tables below were
 * written by hand (not generated) and only ADD lookalikes that UTS #39 does not list, mainly small capitals and a few
 * Latin, Greek, Cyrillic and Cherokee letters; where UTS #39 has an entry, it wins. Lookups run AFTER NFKC,
 * lowercasing and mark removal (Cherokee capitals are listed in both cases because `toLowerCase` maps them to the
 * U+AB70 block). Matching over-folds on purpose: a forbidden-term refusal may be a false positive, never a bypass.
 */
import { UTS39_SKELETON } from "./confusables-data.js";

const LATIN_EXTENSIONS: Record<string, string> = {
  // Small capitals (U+1D00 block and IPA extensions).
  "ᴀ": "a", "ᴁ": "ae", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ꜰ": "f", "ɢ": "g", "ʜ": "h",
  "ɪ": "i", "ᴊ": "j", "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ꞯ": "q",
  "ʀ": "r", "ꜱ": "s", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z",
  // Letters with strokes, hooks and other Latin lookalikes NFKC keeps.
  "ꞩ": "s", "ꞡ": "g", "ꞣ": "k", "ꞥ": "n", "ꞧ": "r", "ɑ": "a", "ɡ": "g", "ɩ": "i", "ȷ": "j",
  "ı": "i", "ł": "l", "ø": "o", "đ": "d", "ħ": "h", "ŀ": "l", "ß": "ss", "ɵ": "o", "ɔ": "o",
  "ǀ": "l", "ʃ": "f", "ʒ": "3", "ƅ": "b", "Ɩ": "l", "Ʀ": "r", "ʀ̆": "r",
};

const GREEK: Record<string, string> = {
  "α": "a", "β": "b", "γ": "y", "δ": "d", "ε": "e", "ζ": "z", "η": "n", "θ": "o", "ι": "i", "κ": "k", "λ": "l", "μ": "u", "ν": "v",
  "ξ": "e", "ο": "o", "π": "n", "ρ": "p", "σ": "o", "ς": "c", "τ": "t", "υ": "u", "φ": "f", "χ": "x", "ψ": "w", "ω": "w", "ϲ": "c",
  "ϳ": "j", "ϱ": "p", "ϵ": "e", "ϐ": "b",
};

const CYRILLIC: Record<string, string> = {
  "а": "a", "б": "b", "в": "b", "г": "r", "д": "d", "е": "e", "ё": "e", "з": "3", "и": "u", "й": "u", "к": "k", "л": "n", "м": "m",
  "н": "h", "о": "o", "п": "n", "р": "p", "с": "c", "т": "t", "у": "y", "ф": "f", "х": "x", "ц": "u", "ч": "4", "ш": "w", "щ": "w",
  "ы": "bi", "ь": "b", "ѕ": "s", "і": "i", "ї": "i", "ј": "j", "ԁ": "d", "ԛ": "q", "ԝ": "w", "ӏ": "l", "һ": "h", "ү": "y", "ҳ": "x",
  "ҫ": "c", "ԍ": "g", "ɡ": "g", "ѵ": "v", "ѡ": "w", "ꙇ": "i",
};

/** Cherokee capitals that look like Latin letters (U+13A0 block). */
const CHEROKEE_CAPITALS: Record<number, string> = {
  0x13a0: "d", 0x13a1: "r", 0x13a2: "t", 0x13a5: "i", 0x13a9: "y", 0x13aa: "a", 0x13ab: "j", 0x13ac: "e", 0x13b3: "w", 0x13b7: "m",
  0x13bb: "h", 0x13bd: "y", 0x13c0: "g", 0x13c2: "h", 0x13c3: "z", 0x13cf: "b", 0x13d9: "v", 0x13da: "s", 0x13de: "l", 0x13df: "c",
  0x13e2: "p", 0x13e6: "k", 0x13f4: "b",
};

function cherokee(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, latin] of Object.entries(CHEROKEE_CAPITALS)) {
    const capital = String.fromCodePoint(Number(code));
    out[capital] = latin;
    // `toLowerCase` maps a Cherokee capital to its small letter (U+AB70 block / U+13F8 block): fold that form too.
    out[capital.toLowerCase()] = latin;
  }
  return out;
}

/**
 * Skeleton map for forbidden-term matching: Unicode UTS #39 confusables (generated, confusables-data.ts) win;
 * the hand tables above add only lookalikes UTS #39 does not list (small capitals, some Latin, Greek, Cyrillic and
 * Cherokee letters). Over-matching is accepted for forbidden terms; a hand entry never overrides UTS #39.
 */
export const CONFUSABLE_SKELETON: Readonly<Record<string, string>> = Object.freeze({
  ...LATIN_EXTENSIONS,
  ...GREEK,
  ...CYRILLIC,
  ...cherokee(),
  ...UTS39_SKELETON,
});

/** Characters that render as nothing but are letters (Lo), so Cf/Mn removal misses them: Hangul fillers, braille blank. */
export const INVISIBLE_LETTERS = /[ᅟᅠㅤﾠ⠀]/gu;
