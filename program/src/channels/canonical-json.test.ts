import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "./canonical-json.js";

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,1,2]},"b":1}',
    );
    expect(canonicalJson([{ z: 1, y: 2 }, [{ b: true, a: null }]])).toBe(
      '[{"y":2,"z":1},[{"a":null,"b":true}]]',
    );
  });

  it("drops undefined object values, keeps null, and renders primitives with JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: null, c: { d: undefined } })).toBe('{"b":null,"c":{}}');
    expect(canonicalJson("é\n\"")).toBe(JSON.stringify("é\n\""));
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(null)).toBe("null");
  });

  it("has no whitespace and is independent of insertion order", () => {
    const one = canonicalJson({ text: "hi there", attachments: [{ name: "a b", sha256: "f" }], v: 1 });
    const two = canonicalJson({ v: 1, attachments: [{ sha256: "f", name: "a b" }], text: "hi there" });
    expect(one).toBe(two);
    expect(one).toBe('{"attachments":[{"name":"a b","sha256":"f"}],"text":"hi there","v":1}');
  });

  it("matches the kit edge cases byte for byte", () => {
    // Kit behaviour: undefined array slots render empty; keys use default sort (code units).
    expect(canonicalJson([1, undefined, 2])).toBe("[1,,2]");
    expect(canonicalJson({ B: 1, a: 2, _: 3 })).toBe('{"B":1,"_":3,"a":2}');
  });

  it("hashes to lowercase hex", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
