// Company Box coverage report: `pnpm run company-box:coverage [--dir <catalog>] [--out <dir>] [--no-write]`.
// Writes coverage.json + COVERAGE.md next to the catalog and exits non-zero on any gap.
import { DEFAULT_COMPANY_BOX_CATALOG_DIR } from "../src/company-box.js";
import { runCompanyBoxCoverageCli } from "../src/company-box-coverage.js";

process.exitCode = runCompanyBoxCoverageCli(process.argv.slice(2), { dir: DEFAULT_COMPANY_BOX_CATALOG_DIR });
