// Composio toolkit coverage: `pnpm run composio:coverage [--dir <policy dir>] [--no-write]`.
// Writes coverage.json + COVERAGE.md next to the policies and exits non-zero on any gap.
import { DEFAULT_COMPOSIO_POLICY_DIR, runComposioCoverageCli } from "../src/composio-coverage.js";

process.exitCode = runComposioCoverageCli(process.argv.slice(2), { dir: DEFAULT_COMPOSIO_POLICY_DIR });
