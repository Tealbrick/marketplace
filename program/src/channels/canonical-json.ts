import { createHash } from "node:crypto";

/**
 * Canonical JSON with the exact semantics of the kit `canonicalJson`
 * (`@tealbrick/kit` approval-verifier): object keys sorted with the default
 * string sort, no whitespace, object entries whose value is `undefined`
 * dropped, arrays kept in order, primitives through `JSON.stringify`.
 *
 * Kept byte-compatible with the kit on purpose, including its edge cases: an
 * `undefined` array element renders as an empty slot (`[1,]`) and a top-level
 * `undefined` returns `undefined`. Callers pass plain JSON-shaped values, so
 * those edges never appear in a digest input.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
