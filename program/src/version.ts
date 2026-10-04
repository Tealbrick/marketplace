import packageJson from "../package.json" with { type: "json" };

/**
 * The Marketplace release version. program/package.json is the source of
 * truth; manifest.json and deploy/railway/recipe.json must match it
 * (enforced by version.test.ts).
 */
export const MARKETPLACE_VERSION: string = packageJson.version;
