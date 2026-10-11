/**
 * Curated, versioned governance policies for Composio toolkits.
 *
 * Composio tool names do not say whether a tool reaches people outside the
 * workspace, destroys data, or even writes (`*_PATCH`, `*_INSERT`, `*_WATCH`
 * read as observe by name). A policy file per toolkit, in
 * `catalog/composio-policy/<toolkit>.json`, pins that: outward tools go
 * through the same approval queue as Company Box outward operations,
 * destructive ones need `connector.admin`, and writes are never observe.
 *
 * Policies are bundled (JSON imports) so the packaged program carries them.
 */
import { z } from "zod";

import googlecalendarPolicy from "../catalog/composio-policy/googlecalendar.json" with { type: "json" };
import readAllowlistFile from "../catalog/composio-read-allowlist.json" with { type: "json" };
import type { GovernedActionRisk } from "./governance.js";
import type { ConnectorCapability } from "./types.js";

const PatternList = z.array(z.string().trim().min(1).max(200)).max(500).default([]);

export const ComposioPolicySchema = z
  .object({
    schema: z.literal(1),
    toolkit: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
    version: z.string().min(1).max(40),
    reviewedAgainst: z.string().optional(),
    notes: z.string().max(4_000).optional(),
    outward: z
      .object({
        always: PatternList,
        unlessQuiet: PatternList,
        quiet: z
          .object({
            argument: z.array(z.string().min(1)).min(1),
            equals: z.union([z.string(), z.boolean()]),
            unlessPresent: z.array(z.string().min(1)).default([]),
            unlessTrue: z.array(z.string().min(1)).default([]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({ always: [], unlessQuiet: [] }),
    destructive: PatternList,
    writes: PatternList,
    reads: PatternList,
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.outward.unlessQuiet.length && !policy.outward.quiet) {
      context.addIssue({ code: "custom", path: ["outward", "quiet"], message: "unlessQuiet needs a quiet rule" });
    }
  });

export type ComposioPolicy = z.infer<typeof ComposioPolicySchema>;

/** Toolkit slug → policy. Add a toolkit by adding its JSON file and one line here. */
const POLICIES: ReadonlyMap<string, ComposioPolicy> = new Map(
  [googlecalendarPolicy].map((raw) => {
    const policy = ComposioPolicySchema.parse(raw);
    return [policy.toolkit, policy] as const;
  }),
);

export function composioPolicies(): ComposioPolicy[] {
  return [...POLICIES.values()];
}

export function composioPolicyFor(toolkit: string): ComposioPolicy | null {
  return POLICIES.get(toolkit.toLowerCase().replace(/[^a-z0-9]+/gu, "")) ?? POLICIES.get(toolkit) ?? null;
}

/** `*` wildcard, case-insensitive, against the Composio tool slug. */
export function composioPatternMatches(pattern: string, toolSlug: string) {
  const regex = new RegExp(
    `^${pattern
      .trim()
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*")}$`,
    "iu",
  );
  return regex.test(toolSlug);
}

function matchesAny(patterns: readonly string[], toolSlug: string) {
  return patterns.some((pattern) => composioPatternMatches(pattern, toolSlug));
}

export type ComposioOutward = "always" | "unlessQuiet" | null;

export type ComposioToolPolicy = {
  capability: ConnectorCapability;
  outward: ComposioOutward;
  destructive: boolean;
};

const CAPABILITY_RANK: Record<ConnectorCapability, number> = {
  "connector.observe": 0,
  "connector.dispatch": 1,
  "connector.admin": 2,
};

/**
 * Static classification of one tool (used when building the listing):
 * destructive → admin; writes and outward → at least dispatch; reads →
 * observe; otherwise the name-inferred capability.
 */
export function composioToolPolicy(
  policy: ComposioPolicy,
  toolSlug: string,
  inferred: ConnectorCapability,
): ComposioToolPolicy {
  const destructive = matchesAny(policy.destructive, toolSlug);
  const outward: ComposioOutward = matchesAny(policy.outward.always, toolSlug)
    ? "always"
    : matchesAny(policy.outward.unlessQuiet, toolSlug)
      ? "unlessQuiet"
      : null;
  let capability = inferred;
  if (destructive) capability = "connector.admin";
  else if (matchesAny(policy.writes, toolSlug) || outward) {
    capability = CAPABILITY_RANK[inferred] >= CAPABILITY_RANK["connector.dispatch"] ? inferred : "connector.dispatch";
  } else if (matchesAny(policy.reads, toolSlug)) capability = "connector.observe";
  return { capability, outward, destructive };
}

function argumentValue(args: Record<string, unknown>, names: readonly string[]) {
  for (const name of names) if (name in args) return args[name];
  return undefined;
}

/**
 * Whether one call reaches outside the workspace. `unlessQuiet` tools are
 * quiet only when the call explicitly turns notifications off and names no
 * recipients; anything missing or unexpected counts as outward.
 */
export function composioCallIsOutward(
  policy: ComposioPolicy,
  toolSlug: string,
  args: Record<string, unknown> | undefined,
) {
  const classification = composioToolPolicy(policy, toolSlug, "connector.observe").outward;
  if (classification !== "unlessQuiet") return classification === "always";
  const quiet = policy.outward.quiet!;
  if (!args) return true;
  if (argumentValue(args, quiet.argument) !== quiet.equals) return true;
  for (const name of quiet.unlessPresent) {
    const value = args[name];
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0) && value !== "") {
      return true;
    }
  }
  return quiet.unlessTrue.some((name) => args[name] === true);
}

/**
 * Reviewed read allowlist for toolkits WITHOUT a curated policy
 * (`catalog/composio-read-allowlist.json`): toolkit → exact tool slugs that a
 * reviewer confirmed cannot write, send, publish, share or notify. Empty by
 * default. Name inference never makes a Composio tool read-only; only this
 * list (or a curated policy) does.
 */
export const ComposioReadAllowlistSchema = z
  .object({
    schema: z.literal(1),
    notes: z.string().max(4_000).optional(),
    toolkits: z.record(
      z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
      z.array(z.string().trim().regex(/^[A-Za-z0-9_]{1,200}$/u)).max(500),
    ),
  })
  .strict();

function compileReadAllowlist(raw: unknown): ReadonlyMap<string, ReadonlySet<string>> {
  const parsed = ComposioReadAllowlistSchema.parse(raw);
  return new Map(
    Object.entries(parsed.toolkits).map(([toolkit, slugs]) => [
      toolkit,
      new Set(slugs.map((slug) => slug.toUpperCase())),
    ]),
  );
}

let READ_ALLOWLIST = compileReadAllowlist(readAllowlistFile);

/** Tests only: replace the bundled read allowlist; returns a restore function. */
export function setComposioReadAllowlistForTests(toolkits: Record<string, string[]>) {
  const previous = READ_ALLOWLIST;
  READ_ALLOWLIST = compileReadAllowlist({ schema: 1, toolkits });
  return () => {
    READ_ALLOWLIST = previous;
  };
}

function toolkitKey(toolkit: string) {
  return toolkit.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

/** True only for a tool on the reviewed read allowlist of an uncurated toolkit. */
export function composioReviewedRead(toolkit: string, toolSlug: string) {
  if (composioPolicyFor(toolkit)) return false;
  const slugs = READ_ALLOWLIST.get(toolkit) ?? READ_ALLOWLIST.get(toolkitKey(toolkit));
  return Boolean(slugs?.has(toolSlug.trim().toUpperCase()));
}

/**
 * Static classification of any Composio tool. Curated toolkits use their
 * policy unchanged. Without a policy, a tool is a reviewed read (observe,
 * not outward) only when it is on the read allowlist; every other tool needs
 * at least `connector.dispatch` and is outward on every call, whatever its
 * name suggests: fail toward approval, never toward silence.
 */
export function composioToolClassification(
  toolkit: string,
  toolSlug: string,
  inferred: ConnectorCapability,
): ComposioToolPolicy & { curated: boolean } {
  const policy = composioPolicyFor(toolkit);
  if (policy) return { ...composioToolPolicy(policy, toolSlug, inferred), curated: true };
  if (composioReviewedRead(toolkit, toolSlug)) {
    return { capability: "connector.observe", outward: null, destructive: false, curated: false };
  }
  return {
    capability: CAPABILITY_RANK[inferred] >= CAPABILITY_RANK["connector.dispatch"] ? inferred : "connector.dispatch",
    outward: "always",
    destructive: false,
    curated: false,
  };
}

/** Per-call risk of one Composio tool (outward may depend on a curated policy's quiet rule). */
export function composioCallRisk(
  toolkit: string,
  toolSlug: string,
  args: Record<string, unknown> | undefined,
  inferred: ConnectorCapability,
): GovernedActionRisk {
  const policy = composioPolicyFor(toolkit);
  const classification = composioToolClassification(toolkit, toolSlug, inferred);
  return {
    write: classification.capability !== "connector.observe",
    outward: policy ? composioCallIsOutward(policy, toolSlug, args) : classification.outward !== null,
    destructive: classification.destructive,
  };
}
