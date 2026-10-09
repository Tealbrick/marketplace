import { describe, expect, it } from "vitest";

import { MAX_ATTACHMENTS_PER_POST, PROVIDER_DECLARATIONS } from "../../web/src/channel-declarations.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./providers/capabilities.js";
import { createDiscordProvider } from "./providers/discord.js";
import { createTelegramProvider } from "./providers/telegram.js";

// The owner UI keeps a copy of the static declarations for the create form
// (the browse answer has no provider declaration before a channel exists).
describe("owner UI provider declarations", () => {
  for (const [id, provider] of [["telegram", createTelegramProvider()], ["discord", createDiscordProvider()]] as const) {
    it(`match the ${id} adapter`, () => {
      const declared = PROVIDER_DECLARATIONS[id];
      const picked = Object.fromEntries(Object.keys(declared).map((key) => [key, (provider.capabilities as Record<string, unknown>)[key]]));
      expect(JSON.parse(JSON.stringify(declared))).toEqual(JSON.parse(JSON.stringify(picked)));
    });
  }

  it("share the attachment cap", () => {
    expect(MAX_ATTACHMENTS_PER_POST).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
  });
});
