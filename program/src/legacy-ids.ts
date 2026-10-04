import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Doppelganger -> Tealbrick identifier migration, transition window.
 *
 * Marketplace accepts both the `tealbrick` and the legacy `doppelganger`
 * spelling wherever it consumes one of these ids. Wherever it produces one, it
 * keeps emitting the legacy id until every consumer accepts the new one.
 *
 * Removal condition: once all consumers listed in the migration PR accept the
 * `tealbrick` ids and Marketplace has flipped emission in a released version,
 * drop the legacy entries here and the `DOPPELGANGER_*` env fallbacks. The
 * `~/.doppelganger` state-dir migration can go after one more release.
 */
export const LEGACY_IDS = {
  /** Rules gateway RPC method (Rules introspection + evaluate request). */
  "tealbrick.rules.evaluate": "doppelganger.rules.evaluate",
  /** Agent connector grant contract carried in Rules payloads. */
  "tealbrick.marketplace.agent-connector-grant.v1":
    "doppelganger.marketplace.agent-connector-grant.v1",
  /** Cross-app broker execute request contract. */
  "tealbrick.cross-app.marketplace.broker-execute.v1":
    "doppelganger.cross-app.marketplace.broker-execute.v1",
  /** Reserved agent actor id. */
  "tealbrick-agent": "doppelganger-agent",
  /** Plugin/product manifest namespace key. */
  tealbrick: "doppelganger",
} as const;

export type CurrentId = keyof typeof LEGACY_IDS;
export type LegacyId = (typeof LEGACY_IDS)[CurrentId];

/** Both accepted spellings, current first. */
export function acceptedIds<T extends CurrentId>(
  current: T,
): readonly [T, (typeof LEGACY_IDS)[T]] {
  return [current, LEGACY_IDS[current]] as const;
}

/** True when `value` is the current id or its legacy alias. */
export function isAcceptedId(current: CurrentId, value: unknown): boolean {
  return value === current || value === LEGACY_IDS[current];
}

/**
 * Read a plugin/product manifest's namespace block, preferring the new
 * `tealbrick` key and falling back to the legacy `doppelganger` key.
 */
export function manifestNamespace(
  manifest: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  for (const key of acceptedIds("tealbrick")) {
    const value = manifest?.[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Environment variables: TEALBRICK_<NAME>, legacy DOPPELGANGER_<NAME>.

export const ENV_PREFIX = "TEALBRICK_";
export const LEGACY_ENV_PREFIX = "DOPPELGANGER_";

export type Warn = (message: string) => void;

const warned = new Set<string>();
const defaultWarn: Warn = (message) => {
  console.warn(message);
};

function warnOnce(key: string, message: string, warn: Warn = defaultWarn) {
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}

/** Test hook: forget which one-time deprecation warnings were already issued. */
export function resetLegacyWarnings() {
  warned.clear();
}

/**
 * Read `TEALBRICK_<name>` and fall back to the deprecated
 * `DOPPELGANGER_<name>`. When only the old name is set, warn once per process.
 */
export function readCompatEnv(
  env: Record<string, string | undefined>,
  name: string,
  warn?: Warn,
): string | undefined {
  const current = env[`${ENV_PREFIX}${name}`]?.trim();
  if (current) return current;
  const legacy = env[`${LEGACY_ENV_PREFIX}${name}`]?.trim();
  if (legacy) {
    warnOnce(
      `env:${name}`,
      `[marketplace] ${LEGACY_ENV_PREFIX}${name} is deprecated; set ${ENV_PREFIX}${name} instead. The old name still works for now.`,
      warn,
    );
    return legacy;
  }
  return undefined;
}

/** `TEALBRICK_DEBUG=1`, or the deprecated `DOPPELGANGER_DEBUG=1`. */
export function compatDebugEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readCompatEnv(env, "DEBUG") === "1";
}

// ---------------------------------------------------------------------------
// Default state directory: ~/.tealbrick/programs/marketplace, legacy
// ~/.doppelganger/programs/marketplace. Only Marketplace's own subtree moves;
// the rest of ~/.doppelganger may belong to other programs and is left alone.

export const STATE_HOME_DIRNAME = ".tealbrick";
export const LEGACY_STATE_HOME_DIRNAME = ".doppelganger";
const MARKETPLACE_STATE_SEGMENTS = ["programs", "marketplace"] as const;

export type StateRootResolution = {
  root: string;
  status:
    | "fresh"
    | "current"
    | "legacy-in-place"
    | "migrated"
    | "both-present";
};

function isDirectory(target: string) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve Marketplace's default state root (holds `data/` and `logs/`).
 *
 * - new dir present: use it (if the legacy dir also exists, warn and leave it).
 * - only legacy present and `migrate`: atomically rename it to the new path,
 *   leaving a symlink at the old path so anything still pointing there keeps
 *   working. If the rename fails (e.g. EXDEV across filesystems), keep using
 *   the legacy path and warn. Data is never deleted.
 * - only legacy present and not `migrate`: use the legacy path read-only.
 * - neither present: use the new path.
 *
 * Explicit overrides (MARKETPLACE_DATA_DIR, TEALBRICK_/DOPPELGANGER_
 * PRODUCT_WORKSPACE_DIR, PRODUCT_WORKSPACE_DIR) bypass this entirely.
 */
export function resolveDefaultStateRoot(
  options: { homeDir?: string; migrate?: boolean; warn?: Warn } = {},
): StateRootResolution {
  const homeDir = options.homeDir ?? os.homedir();
  const warn = options.warn ?? defaultWarn;
  const root = path.join(homeDir, STATE_HOME_DIRNAME, ...MARKETPLACE_STATE_SEGMENTS);
  const legacyRoot = path.join(
    homeDir,
    LEGACY_STATE_HOME_DIRNAME,
    ...MARKETPLACE_STATE_SEGMENTS,
  );

  const legacyIsLink = (() => {
    try {
      return fs.lstatSync(legacyRoot).isSymbolicLink();
    } catch {
      return false;
    }
  })();

  if (isDirectory(root)) {
    if (!legacyIsLink && isDirectory(legacyRoot)) {
      warnOnce(
        `state:both:${legacyRoot}`,
        `[marketplace] Using ${root}. A legacy state directory still exists at ${legacyRoot}; it was not modified or removed.`,
        warn,
      );
      return { root, status: "both-present" };
    }
    return { root, status: "current" };
  }

  if (!isDirectory(legacyRoot)) {
    return { root, status: "fresh" };
  }

  if (!options.migrate) {
    return { root: legacyRoot, status: "legacy-in-place" };
  }

  try {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.renameSync(legacyRoot, root);
  } catch (error) {
    warnOnce(
      `state:stay:${legacyRoot}`,
      `[marketplace] Could not move legacy state ${legacyRoot} to ${root} (${(error as NodeJS.ErrnoException)?.code ?? String(error)}); continuing to use the legacy path. Move it manually or set MARKETPLACE_DATA_DIR.`,
      warn,
    );
    return { root: legacyRoot, status: "legacy-in-place" };
  }
  try {
    fs.symlinkSync(root, legacyRoot, "dir");
  } catch {
    // Best effort: the data now lives at `root` either way.
  }
  warnOnce(
    `state:migrated:${legacyRoot}`,
    `[marketplace] Moved state from ${legacyRoot} to ${root} (a symlink remains at the old path).`,
    warn,
  );
  return { root, status: "migrated" };
}
