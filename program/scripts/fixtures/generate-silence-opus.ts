// Regenerates silence-1s.ogg: `pnpm -C program exec tsx scripts/fixtures/generate-silence-opus.ts`.
// The output is deterministic; the unit test fails when the committed file differs from the generator.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildSilenceOpus } from "../lib/ogg-opus.js";

writeFileSync(fileURLToPath(new URL("./silence-1s.ogg", import.meta.url)), buildSilenceOpus());
