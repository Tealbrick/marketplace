import { describe, expect, it } from "vitest";
import { sanitizeFilename, sanitizeText, scrubSecrets } from "./common.js";

describe("scrubSecrets", () => {
  const token = "1234567:AAHfaketokenfaketokenfaketoken12345";
  it("removes the raw token, the bot<token> URL form and the encoded form", () => {
    const text = `GET https://api.telegram.org/bot${token}/getMe failed for ${token} / ${encodeURIComponent(token)}`;
    const out = scrubSecrets(text, [token, `bot${token}`]);
    expect(out).not.toContain(token);
    expect(out).not.toContain("AAHfake");
    expect(out).toContain("[redacted]");
  });

  it("removes token-shaped strings it was not told about", () => {
    const out = scrubSecrets("saw bot987654321:ZZZfaketokenfaketokenfaketoken123456 in a log", []);
    expect(out).not.toContain("987654321");
  });

  it("ignores empty secrets", () => {
    expect(scrubSecrets("plain text", [""])).toBe("plain text");
  });
});

describe("sanitizeText and sanitizeFilename", () => {
  it("strips control and bidi characters and caps by code points", () => {
    expect(sanitizeText("a\u0000b‮c\n d")).toBe("a b c d");
    expect(Array.from(sanitizeText("😀".repeat(200), 128))).toHaveLength(128);
    expect(sanitizeText(undefined)).toBe("");
  });

  it("makes a safe file name", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(sanitizeFilename("")).toBe("file");
  });
});
