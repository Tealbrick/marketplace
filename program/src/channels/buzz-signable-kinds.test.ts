import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BUZZ_KIND } from "./providers/buzz.js";
import { BUZZ_SIGNABLE_KINDS, BuzzKindNotAllowedError, generateSecretKey, signEvent } from "./providers/nostr.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    // Test files and the test-only fake relay (it signs as other keys with its own signer) are not Marketplace code.
    return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts") && name !== "buzz-test-relay.ts" && name !== "test-support.ts" ? [full] : [];
  });
}

describe("Buzz signable kinds", () => {
  it("is exactly the agreed list", () => {
    // Changing this needs a spec change (docs/channels-p2-scope.md §3).
    expect([...BUZZ_SIGNABLE_KINDS]).toEqual([9, 7, 5, 40003, 41010, 9007, 9000, 9001, 9008, 20002, 22242, 27235, 24242]);
  });

  it("is enforced at the one signing function", () => {
    const secret = generateSecretKey();
    for (const kind of [0, 1, 3, 1059, 9005, 9021, 30023, 40002, 40100, 44100, 39000]) {
      expect(() => signEvent(secret, { kind, created_at: 1, tags: [], content: "" }), String(kind)).toThrow(BuzzKindNotAllowedError);
    }
    for (const kind of BUZZ_SIGNABLE_KINDS) expect(signEvent(secret, { kind, created_at: 1, tags: [], content: "" }).kind).toBe(kind);
  });

  it("no source file builds an event of a kind outside the list, only nostr.ts and buzz.ts call signEvent, and publish() checks the list", () => {
    const buzzSource = readFileSync(path.join(SRC, "channels", "providers", "buzz.ts"), "utf8");
    const publishBody = buzzSource.slice(buzzSource.indexOf("async function publish("), buzzSource.indexOf("const fromFailure"));
    expect(publishBody).toMatch(/if \(!BUZZ_SIGNABLE_KINDS\.includes\(input\.kind\)\)[\s\S]*buzz_kind_not_allowed/u);
    const kindNames = BUZZ_KIND as Readonly<Record<string, number>>;
    const offenders: string[] = [];
    const signers: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      const relative = path.relative(SRC, file);
      if (/\bsignEvent\(/u.test(text.replace(/export function signEvent\(/u, ""))) signers.push(relative);
      if (!/\bsignEvent\(|\bpublish\(|bridgeCall\(|nip98Authorization|blossomUploadAuthorization|authEvent\(/u.test(text)) continue;
      for (const match of text.matchAll(/\bkind:\s*(\d+)\b/gu)) {
        if (!BUZZ_SIGNABLE_KINDS.includes(Number(match[1]))) offenders.push(`${relative}: kind ${match[1]}`);
      }
      for (const match of text.matchAll(/\bkind:\s*BUZZ_KIND\.(\w+)/gu)) {
        const value = kindNames[match[1]!];
        if (value === undefined || !BUZZ_SIGNABLE_KINDS.includes(value)) offenders.push(`${relative}: BUZZ_KIND.${match[1]} (${value})`);
      }
    }
    expect(offenders).toEqual([]);
    expect(signers.sort()).toEqual([path.join("channels", "providers", "buzz.ts"), path.join("channels", "providers", "nostr.ts")]);
  });
});
