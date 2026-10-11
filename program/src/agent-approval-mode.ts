/**
 * Per-agent approval mode in owner governance mode (no Rules service).
 *
 * - `system` (the default for every agent without an owner setting, fail closed): every outward call is held for
 *   the owner (company_box_approval), as before.
 * - `assistant`: outward calls run at once and leave a receipt in Activity, EXCEPT sensitive actions (the families
 *   below, curated destructive flags, admin-by-name/hint tools) and calls over the agent's daily limits: those are
 *   held exactly like `system`.
 *
 * Only the owner sets the mode (owner launch session + CSRF + pinned owner). The mode never widens a consent: the
 * Portal consent class still decides what an agent may call at all. Rules mode is unchanged: Rules decides.
 *
 * Source of truth: PORTAL. The verified grant / lease claims carry `agentPolicy` ({approvalMode, paused,
 * holdFamilies?}); when present it wins. The local owner setting (mode, pause, families, limits; table
 * agent_approval_setting and friends) is a TEMPORARY FALLBACK until Portal ships the mode claim
 * (@tealbrick/contract/approval-mode): remove it in the next release. Do not add local features. The exported
 * function names stay, so the swap to the contract helper is mechanical.
 */
import type { AgentOutwardReceipt } from "./agent-mode-store.js";
import type { SqliteMarketplaceStore } from "./store.js";

export type AgentApprovalMode = "assistant" | "system";

export const DEFAULT_AGENT_DAILY_CAP = 100;
export const DEFAULT_AGENT_CONNECTOR_DAILY_CAP = 50;
export const MAX_AGENT_DAILY_CAP = 10_000;

/** Families held in Assistant mode: four matched on tool names, two declared by the caller (Channels). */
export type HoldFamilyId = "destructive" | "money" | "access-sharing" | "bulk" | "first-contact-dm" | "live-session-grant";
/** The slug-matched families (the ones classifySensitive can return). */
export type SensitiveFamily = "destructive" | "money" | "access-sharing" | "bulk";

export type HoldFamilyDefinition = {
  readonly id: HoldFamilyId;
  readonly label: string;
  readonly description: string;
  /**
   * Slug matcher: words matched against the tool name's word segments (Composio `GMAIL_SEND_EMAIL`, custom MCP
   * `send_message` / `sendMessage`), case-insensitive, as whole segments; the last word may be plural (`REFUNDS`).
   * `BULK_*` / `MASS_*`: the segment followed by another one; `*_ALL`: the last segment `ALL` after another one.
   * Absent: a caller-declared family (decideOutward `families`).
   */
  readonly words?: readonly string[];
  /** Held for Assistant agents unless the owner (or Portal's agentPolicy) turns it off. */
  readonly defaultOn: true;
  /** Always held in Assistant mode: neither the owner nor Portal can turn it off (destructive, money). */
  readonly locked: boolean;
};

/**
 * The registry of hold families. Which ones are ON is an owner setting per workspace (absent = default ON); System
 * mode ignores families (every outward call is held); curated destructive flags and `connector.admin` tools stay held
 * regardless (they are not a family toggle).
 */
export const HOLD_FAMILIES: ReadonlyArray<HoldFamilyDefinition> = Object.freeze(
  ([
    {
      id: "destructive",
      label: "Deletes and resets",
      description: "Deleting, emptying, overwriting, revoking, disabling, banning or resetting things.",
      words: ["DELETE", "REMOVE", "PURGE", "WIPE", "TRASH", "EMPTY", "OVERWRITE", "REPLACE_ALL", "REVOKE", "DISABLE", "BAN", "KICK", "RESET", "ARCHIVE_ALL"],
      defaultOn: true,
      locked: true,
    },
    {
      id: "money",
      label: "Payments and refunds",
      description: "Paying, charging, transferring, ordering, subscribing or refunding.",
      // MONEY: added after QA's runtime-slug check (ACME_SEND_MONEY ran unheld with the original list).
      words: ["PAY", "CHARGE", "TRANSFER", "PAYOUT", "PURCHASE", "ORDER", "SUBSCRIBE", "CANCEL_SUBSCRIPTION", "REFUND", "MONEY"],
      defaultOn: true,
      locked: true,
    },
    {
      id: "access-sharing",
      label: "Sharing and permissions",
      description: "Sharing, inviting, granting access, changing owners or permissions, forwarding, creating keys, webhooks or mail rules.",
      words: [
        "SHARE", "INVITE", "ADD_MEMBER", "GRANT", "SET_PERMISSION", "UPDATE_PERMISSIONS", "CHANGE_OWNER", "TRANSFER_OWNERSHIP",
        "FORWARD", "CREATE_API_KEY", "CREATE_TOKEN", "ADD_WEBHOOK", "CREATE_FORWARDING_RULE", "CREATE_FILTER",
      ],
      defaultOn: true,
      locked: false,
    },
    {
      id: "bulk",
      label: "Bulk and broadcast",
      description: "Bulk actions and messages to everyone at once.",
      words: ["BULK_*", "*_ALL", "SEND_TO_ALL", "BROADCAST", "MASS_*"],
      defaultOn: true,
      locked: false,
    },
    {
      id: "first-contact-dm",
      label: "First message to a new person",
      description: "A direct message to someone the agent has not written to before (declared by Channels).",
      defaultOn: true,
      locked: false,
    },
    {
      id: "live-session-grant",
      label: "Live sessions",
      description: "Starting or granting a live session such as a voice huddle (declared by Channels).",
      defaultOn: true,
      locked: false,
    },
  ] as HoldFamilyDefinition[]).map((entry) => Object.freeze({ ...entry, ...(entry.words ? { words: Object.freeze([...entry.words]) } : {}) })),
);

const HOLD_FAMILY_IDS: ReadonlySet<string> = new Set(HOLD_FAMILIES.map((family) => family.id));

export function isHoldFamilyId(value: string): value is HoldFamilyId {
  return HOLD_FAMILY_IDS.has(value);
}

/** The slug-matched families as `{family, label, words}` (the "What still waits?" word lists). */
export const SENSITIVE_ACTION_FAMILIES: ReadonlyArray<{ readonly family: SensitiveFamily; readonly label: string; readonly words: readonly string[] }> =
  Object.freeze(
    HOLD_FAMILIES.filter((family) => family.words).map((family) =>
      Object.freeze({ family: family.id as SensitiveFamily, label: family.label, words: family.words! }),
    ),
  );

/** Upper-case word segments of a tool name; a leading `<TOOLKIT>_` (Composio) is dropped. */
export function toolNameSegments(name: string, toolkit?: string): string[] {
  const segments = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((segment) => segment.toUpperCase());
  const prefix = toolkit
    ? toolkit
        .split(/[^A-Za-z0-9]+/u)
        .filter(Boolean)
        .map((segment) => segment.toUpperCase())
    : [];
  if (prefix.length && segments.length > prefix.length && prefix.every((segment, index) => segments[index] === segment)) {
    return segments.slice(prefix.length);
  }
  return segments;
}

/** The run's last word may be plural (`REFUNDS`, `INVITES`, `ORDERS`): holding more is the safe side. */
function segmentMatches(actual: string | undefined, word: string, last: boolean) {
  return actual === word || (last && (actual === `${word}S` || actual === `${word}ES`));
}

function containsRun(segments: readonly string[], run: readonly string[]) {
  for (let start = 0; start + run.length <= segments.length; start += 1) {
    if (run.every((segment, offset) => segmentMatches(segments[start + offset], segment, offset === run.length - 1))) return true;
  }
  return false;
}

function wordMatches(word: string, segments: readonly string[]) {
  if (word.endsWith("_*")) {
    const head = word.slice(0, -2);
    return segments.slice(0, -1).includes(head);
  }
  if (word.startsWith("*_")) {
    const tail = word.slice(2);
    return segments.length > 1 && segments[segments.length - 1] === tail;
  }
  return containsRun(segments, word.split("_"));
}

export type SensitiveMatch = { family: SensitiveFamily; word: string };

/** Every sensitive family word the tool name matches (empty: not sensitive by name). */
export function sensitiveMatches(name: string, toolkit?: string): SensitiveMatch[] {
  const segments = toolNameSegments(name, toolkit);
  return SENSITIVE_ACTION_FAMILIES.flatMap((family) =>
    family.words.filter((word) => wordMatches(word, segments)).map((word) => ({ family: family.family, word })),
  );
}

/**
 * Whether a tool name is sensitive (held in Assistant mode): the first matching slug family that is ON. `settings`:
 * the workspace's family states (getHoldFamilies); without them every family is ON (the defaults).
 */
export function classifySensitive(
  slug: string,
  settings?: { toolkit?: string; families?: ReadonlyArray<{ id: string; on: boolean }> },
): { sensitive: boolean; family?: SensitiveFamily; word?: string } {
  const off = new Set((settings?.families ?? []).filter((family) => !family.on).map((family) => family.id));
  const match = sensitiveMatches(slug, settings?.toolkit).find((candidate) => !off.has(candidate.family));
  return match ? { sensitive: true, family: match.family, word: match.word } : { sensitive: false };
}

/**
 * The risk decideOutward needs. `destructive`: a curated destructive flag or a `connector.admin` tool (destructive by
 * name or hint). `sensitive`: classifySensitive(tool name).
 */
export type OutwardRisk = {
  outward: boolean;
  /** Curated destructive flag or `connector.admin`: held in Assistant mode regardless of family settings. */
  destructive: boolean;
  /** The caller already decided it is sensitive (always held in Assistant mode). */
  sensitive: boolean;
};

export type OutwardReason =
  | "paused"
  | "system_mode"
  | "sensitive"
  | "destructive"
  | "cap_agent"
  | "cap_connector"
  | "not_outward"
  | "assistant";

/** The UTC day a call counts against (`YYYY-MM-DD`); limits reset at 00:00 UTC. */
export function utcDay(now: Date) {
  return now.toISOString().slice(0, 10);
}

const SECRET_KEY = /key|token|secret|passw|authorization|credential|cookie|bearer|private|signature/iu;
const SECRET_VALUE = /^(?:bearer\s+\S+|sk[-_][A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.?[A-Za-z0-9_-]*|[A-Za-z0-9+/_=-]{40,})$/iu;

/** Token-looking runs inside free text (API keys, bearer tokens, JWTs, long opaque strings). */
const SECRET_IN_TEXT = /(?:bearer\s+[A-Za-z0-9._~+/-]{8,}=*|\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{8,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\bAKIA[A-Z0-9]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?|\b[A-Za-z0-9_-]{32,})/giu;

/** Arguments with secret-looking keys and token-looking values replaced; used for receipts. */
export function redactArguments(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") {
    return SECRET_VALUE.test(value.trim()) ? "[redacted]" : value.replace(SECRET_IN_TEXT, "[redacted]");
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactArguments(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) ? "[redacted]" : redactArguments(entry, depth + 1),
    ]),
  );
}

const DESTINATION_KEYS = [
  "recipient_email", "recipient", "recipients", "to", "email", "cc", "channel", "channel_id", "channelId",
  "chat_id", "chatId", "conversation_id", "user_id", "url", "repo", "repository", "owner", "calendar_id",
];

/** Where an outward call goes, when the arguments name it (bounded, redacted). */
export function receiptDestination(args: Record<string, unknown>): string | null {
  for (const key of DESTINATION_KEYS) {
    const raw = args[key];
    const value = Array.isArray(raw) ? raw.filter((entry) => typeof entry === "string").join(", ") : raw;
    if (typeof value === "string" && value.trim()) {
      const redacted = redactArguments(value.trim());
      return `${key}: ${String(redacted).slice(0, 200)}`;
    }
  }
  return null;
}

// --- Store-backed decisions: the ONE implementation every outward path uses (connectors now, Channels next). -------
// Only consulted in owner governance mode (no Rules service): with Rules, Rules decides every outward call and
// these functions are not called (the kill switch, isAgentPaused, still applies in both modes).

export type ModeStore = Pick<SqliteMarketplaceStore, "agentModes" | "recordAudit">;

/**
 * Portal's per-agent policy claim (contract alpha.10): `agentPolicy: { v: 1, approvalMode: "assistant" | "system",
 * paused: boolean, holdFamilies?: { "access-sharing"?, bulk?, "first-contact-dm"?, "live-session-grant"?: boolean },
 * rev: number }`, carried by the app-grant introspection answer (L1) and JWT (L2), the Marketplace credential lease /
 * handoff attachment, and the kit runtime config. Passed around raw as `policy` (undefined: no claim). Companion
 * (app-to-app) grants carry none. Parsing lives in parseAgentPolicy only (moves to @tealbrick/contract/approval-mode).
 */
export const AGENT_POLICY_CLAIM = "agentPolicy";

export type AgentPolicy = {
  approvalMode: AgentApprovalMode;
  paused: boolean;
  /** Only the overridable families Portal sets; destructive and money are never taken from the claim. */
  holdFamilies: Partial<Record<HoldFamilyId, boolean>>;
  /** The policy revision, or null when the claim is malformed. */
  rev: number | null;
};
type AgentRef = { workspaceSlug: string; agentId: string; policy?: unknown; now?: Date };

/** The first verified claim set that carries the agent policy (introspection answer first, then token claims). */
export function agentPolicyFrom(...sources: Array<Record<string, unknown> | null | undefined>): unknown {
  for (const source of sources) if (source && source[AGENT_POLICY_CLAIM] !== undefined) return source[AGENT_POLICY_CLAIM];
  return undefined;
}

/**
 * Parse a present agentPolicy (fail closed). Undefined: null (absent; the local owner setting applies). Otherwise:
 * not an object, `v` missing or not 1, `rev` not a non-negative integer, an unknown `approvalMode`, or a wrong type
 * on a known key (`v`, `rev`, `approvalMode`, `paused`, `holdFamilies`) → `system` (still a present claim).
 * `paused` only when exactly `true`. `holdFamilies`: only the overridable families, off only when exactly `false`;
 * `destructive` and `money` are ignored (always held). Unknown keys are ignored.
 */
export function parseAgentPolicy(raw: unknown): AgentPolicy | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { approvalMode: "system", paused: false, holdFamilies: {}, rev: null };
  const value = raw as Record<string, unknown>;
  const rev = typeof value.rev === "number" && Number.isInteger(value.rev) && value.rev >= 0 ? value.rev : null;
  const familiesValue = value.holdFamilies;
  const malformed =
    value.v !== 1 ||
    rev === null ||
    (value.approvalMode !== undefined && typeof value.approvalMode !== "string") ||
    (value.paused !== undefined && typeof value.paused !== "boolean") ||
    (familiesValue !== undefined && (!familiesValue || typeof familiesValue !== "object" || Array.isArray(familiesValue)));
  const holdFamilies: Partial<Record<HoldFamilyId, boolean>> = {};
  if (!malformed && familiesValue) {
    const families = familiesValue as Record<string, unknown>;
    for (const family of HOLD_FAMILIES) {
      if (!family.locked && typeof families[family.id] === "boolean") holdFamilies[family.id] = families[family.id] as boolean;
    }
  }
  return {
    approvalMode: !malformed && value.approvalMode === "assistant" ? "assistant" : "system",
    paused: value.paused === true,
    holdFamilies,
    rev,
  };
}

/**
 * The claim to use for this call: parsed, and `system` when its `rev` is LOWER than the highest revision seen for
 * this agent (stale, as the contract's isStalePolicy). A higher revision is recorded.
 */
export function effectiveAgentPolicy(store: ModeStore, ref: AgentRef): AgentPolicy | null {
  const parsed = parseAgentPolicy(ref.policy);
  if (!parsed || parsed.rev === null) return parsed;
  const seen = store.agentModes.lastPolicyRev(ref.workspaceSlug, ref.agentId);
  if (seen !== null && parsed.rev < seen) return { ...parsed, approvalMode: "system", holdFamilies: {} };
  if (seen === null || parsed.rev > seen) store.agentModes.recordPolicyRev(ref.workspaceSlug, ref.agentId, parsed.rev);
  return parsed;
}

/**
 * The agent's mode. Claim present: the STRICTER of the claim and a stored local owner setting (System beats
 * Assistant; the local setting can only tighten). Claim absent: the local owner setting (temporary fallback), System
 * when there is none (fail closed).
 */
export function getAgentApprovalMode(store: ModeStore, ref: AgentRef): AgentApprovalMode {
  const local = store.agentModes.getSetting(ref.workspaceSlug, ref.agentId);
  const claimed = effectiveAgentPolicy(store, ref);
  if (!claimed) return local.mode;
  return claimed.approvalMode === "assistant" && (!local.stored || local.mode === "assistant") ? "assistant" : "system";
}

/**
 * The kill switch: paused when either source says so (claim `paused: true`: scope `claim`; the local pause of this
 * agent: `agent`; of all agents: `global`).
 */
export function isAgentPaused(store: ModeStore, ref: AgentRef): { paused: boolean; scope: "claim" | "agent" | "global" | null } {
  // Every verified read of the claim is remembered, so a held call can be re-checked against it on approval.
  if (ref.policy !== undefined) store.agentModes.recordPolicySeen(ref.workspaceSlug, ref.agentId, ref.policy, ref.now ?? new Date());
  if (parseAgentPolicy(ref.policy)?.paused === true) return { paused: true, scope: "claim" };
  const state = store.agentModes.pauseState(ref.workspaceSlug, ref.agentId);
  return { paused: state !== null, scope: state === "all" ? "global" : state };
}

/** A held call approved by the owner runs only on a policy read at most this old. */
export const FRESH_POLICY_MAX_AGE_MS = 60_000;

/**
 * The policy to re-check an approved held call against, at execution time (contract approval-mode): `none` when
 * Portal never sent a claim for this agent (local fallback applies), `fresh` with the claim when the last verified
 * read is at most 60 s old, `stale` otherwise (the call must not run on it: no fresh read is available, since the
 * owner's approval carries no agent credential to introspect with).
 */
export function freshAgentPolicy(
  store: ModeStore,
  ref: { workspaceSlug: string; agentId: string },
  now: Date = new Date(),
  maxAgeMs: number = FRESH_POLICY_MAX_AGE_MS,
): { state: "none" } | { state: "stale"; seenAt: string } | { state: "fresh"; policy: unknown } {
  const seen = store.agentModes.lastPolicySeen(ref.workspaceSlug, ref.agentId);
  if (!seen) return { state: "none" };
  const age = now.getTime() - Date.parse(seen.seenAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs ? { state: "fresh", policy: seen.policy } : { state: "stale", seenAt: seen.seenAt };
}

/**
 * The registry with the families' current state for this workspace (and claim, when given): locked families always
 * ON; the stricter of the claim and the local owner setting when a claim is present; the local setting otherwise.
 */
export function getHoldFamilies(
  store: ModeStore,
  workspaceSlug: string,
  policy?: unknown,
): Array<HoldFamilyDefinition & { on: boolean; updatedBy: string | null; updatedAt: string | null }> {
  const claimed = parseAgentPolicy(policy);
  const settings = store.agentModes.getFamilySettings(workspaceSlug);
  return HOLD_FAMILIES.map((family) => {
    const setting = settings.get(family.id);
    // Locked families are always ON. Otherwise the local setting (absent = default ON); with a claim present the
    // stricter of both: a family is off only when the claim AND the local setting turn it off.
    const local = family.locked || (setting ? setting.enabled : family.defaultOn);
    const on = claimed ? local || (claimed.holdFamilies[family.id] ?? family.defaultOn) : local;
    return { ...family, on, updatedBy: setting?.updatedBy ?? null, updatedAt: setting?.updatedAt ?? null };
  });
}

/**
 * Why an outward call is held for an Assistant agent in this workspace, or null when it may run (limits aside):
 * curated destructive / admin always; then any ON caller-declared family; then the first ON slug family.
 */
export function assistantHold(
  store: ModeStore,
  input: { workspaceSlug: string; risk: OutwardRisk; slug?: string; toolkit?: string; families?: readonly string[]; policy?: unknown },
): { reason: "destructive" | "sensitive"; family?: HoldFamilyId } | null {
  if (!input.risk.outward) return null;
  if (input.risk.destructive) return { reason: "destructive" };
  if (input.risk.sensitive) return { reason: "sensitive" };
  const families = getHoldFamilies(store, input.workspaceSlug, input.policy);
  const declared = (input.families ?? []).find((id) => families.some((family) => family.id === id && family.on));
  if (declared) return { reason: "sensitive", family: declared as HoldFamilyId };
  if (input.slug) {
    const match = classifySensitive(input.slug, { toolkit: input.toolkit, families });
    if (match.sensitive) return { reason: "sensitive", family: match.family };
  }
  return null;
}

export type OutwardDecision = {
  kind: "run" | "hold" | "refuse";
  reason: OutwardReason;
  /** Present on an Assistant run: commit it (provider reached) or release it (never reached). */
  capReservation?: string;
  /** The same replay key already ran under Assistant mode: return its stored outcome, never call the provider again. */
  replay?: boolean;
  /** For `sensitive`: the family that held it (slug-matched or caller-declared). */
  family?: HoldFamilyId;
  /** For `cap_agent`: held because the cap store could not be read (never treated as unlimited). */
  capUnavailable?: true;
};

/**
 * Decide one agent call in owner governance mode: refuse (paused), run (not outward, or Assistant within the daily
 * limits) or hold (System mode, destructive, sensitive, or over a daily limit). An Assistant run reserves one
 * execution against both daily limits atomically (one SQLite transaction, before the provider call) and returns the
 * reservation. Counting rule: a reservation counts unless it is released; commit it when the provider was reached
 * (succeeded OR failed: a failed provider call counts and leaves a receipt), release it when the call stopped before
 * the provider. A replay with the same `replayKey` returns the first reservation and counts once.
 */
export function decideOutward(
  store: ModeStore,
  input: AgentRef & {
    connectorKey: string;
    actionKey: string;
    risk: OutwardRisk;
    /** Tool name matched against the ON slug families (`toolkit`: a Composio prefix to drop). */
    slug?: string;
    toolkit?: string;
    /** Caller-declared families, e.g. `["first-contact-dm"]`: held when any is ON for the workspace. */
    families?: readonly string[];
    /** Portal's raw `agentPolicy` claim from the verified grant or lease (undefined: none; local fallback). */
    policy?: unknown;
    now?: Date;
    /** Idempotency scope of the call (counts once, replays never re-run). */
    replayKey?: string | null;
    provider?: string;
    accountRef?: string | null;
    argumentsPreview?: string;
    destination?: string | null;
    traceId?: string | null;
  },
): OutwardDecision {
  if (isAgentPaused(store, input).paused) return { kind: "refuse", reason: "paused" };
  if (!input.risk.outward) return { kind: "run", reason: "not_outward" };
  const modes = store.agentModes;
  if (input.replayKey) {
    const ran = modes.findReceiptByKey({ workspaceSlug: input.workspaceSlug, agentId: input.agentId, pluginId: input.connectorKey, replayKey: input.replayKey });
    if (ran && ran.status !== "not_run") return { kind: "run", reason: "assistant", capReservation: ran.id, replay: true };
  }
  let setting: ReturnType<typeof modes.getSetting>;
  try {
    setting = modes.getSetting(input.workspaceSlug, input.agentId);
    // System mode ignores families: every outward call is held.
    if (getAgentApprovalMode(store, input) !== "assistant") return { kind: "hold", reason: "system_mode" };
    const held = assistantHold(store, input);
    if (held) return { kind: "hold", reason: held.reason, ...(held.family ? { family: held.family } : {}) };
  } catch {
    // The mode store cannot be read: fail toward approval.
    return { kind: "hold", reason: "system_mode" };
  }
  // A cap is never "unlimited": a missing or invalid cap counts as 0 (hold).
  const capOf = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);
  const now = input.now ?? new Date();
  let reserved: ReturnType<typeof modes.reserveExecution>;
  try {
    reserved = modes.reserveExecution({
    workspaceSlug: input.workspaceSlug,
    agentId: input.agentId,
    pluginId: input.connectorKey,
    provider: input.provider ?? input.connectorKey,
    actionKey: input.actionKey,
    toolSlug: input.slug ?? null,
    accountRef: input.accountRef ?? null,
    destination: input.destination ?? null,
    argumentsPreview: input.argumentsPreview ?? "",
    replayKey: input.replayKey ?? null,
    traceId: input.traceId ?? "",
    now,
    day: utcDay(now),
    dailyCap: capOf(setting.dailyCap),
    connectorDailyCap: capOf(setting.connectorDailyCap),
    });
  } catch {
    // The cap store is unavailable: the limit cannot be checked, so the call waits.
    return { kind: "hold", reason: "cap_agent", capUnavailable: true };
  }
  if (reserved.kind === "cap") return { kind: "hold", reason: reserved.limit === "agent" ? "cap_agent" : "cap_connector" };
  return { kind: "run", reason: "assistant", capReservation: reserved.receipt.id, ...(reserved.kind === "replay" ? { replay: true } : {}) };
}

/** The provider was reached (succeeded or failed): the execution counts. Idempotent. */
export function commitCapReservation(store: ModeStore, input: { reservationId: string; status: "ok" | "failed"; error?: string | null; now?: Date }) {
  return store.agentModes.finishReceipt({
    id: input.reservationId,
    status: input.status === "ok" ? "succeeded" : "failed",
    error: input.error ?? null,
    now: input.now ?? new Date(),
  });
}

/** The call stopped before the provider: the reservation does not count. Idempotent. */
export function releaseCapReservation(store: ModeStore, input: { reservationId: string; error?: string | null; now?: Date }) {
  return store.agentModes.finishReceipt({ id: input.reservationId, status: "not_run", error: input.error ?? null, now: input.now ?? new Date() });
}

/**
 * The owner-visible receipt of one outward execution an agent ran without approval (Activity / audit trail).
 * With `reservationId` it completes that reservation's row; without one it records a finished row (counted).
 * `argumentsPreview` must already be redacted (receiptPreview).
 */
export function writeOutwardReceipt(
  store: ModeStore,
  input: AgentRef & {
    connectorKey: string;
    accountRef: string | null;
    actionKey: string;
    /** The tool the provider received (Composio slug), when known. */
    toolSlug?: string | null;
    argumentsPreview: string;
    destination?: string | null;
    status: "ok" | "failed";
    mode: AgentApprovalMode;
    policyId?: string | null;
    provider?: string;
    reservationId?: string;
    error?: string | null;
    now?: Date;
  },
): AgentOutwardReceipt | null {
  const now = input.now ?? new Date();
  const modes = store.agentModes;
  const receipt = input.reservationId
    ? modes.getReceipt(input.reservationId)
    : modes.recordFinishedReceipt({
        workspaceSlug: input.workspaceSlug,
        agentId: input.agentId,
        pluginId: input.connectorKey,
        provider: input.provider ?? input.connectorKey,
        actionKey: input.actionKey,
        toolSlug: input.toolSlug ?? null,
        accountRef: input.accountRef,
        destination: input.destination ?? null,
        argumentsPreview: input.argumentsPreview,
        mode: input.mode,
        status: input.status === "ok" ? "succeeded" : "failed",
        error: input.error ?? null,
        now,
        day: utcDay(now),
      });
  store.recordAudit({
    workspaceSlug: input.workspaceSlug,
    pluginId: input.connectorKey,
    eventType: OUTWARD_RECEIPT_EVENT,
    actorId: `agent:${input.agentId}`,
    metadata: {
      ...(receipt ? { receiptId: receipt.id } : {}),
      agentId: input.agentId,
      pluginId: input.connectorKey,
      provider: input.provider ?? receipt?.provider ?? input.connectorKey,
      actionKey: input.actionKey,
      toolSlug: input.toolSlug ?? receipt?.toolSlug ?? null,
      account: input.accountRef,
      destination: input.destination ?? null,
      argumentsPreview: input.argumentsPreview,
      status: input.status === "ok" ? "succeeded" : "failed",
      ...(input.error ? { error: input.error } : {}),
      mode: input.mode,
      ...(input.policyId ? { policyId: input.policyId } : {}),
      at: now.toISOString(),
    },
  });
  return receipt;
}

export const OUTWARD_RECEIPT_EVENT = "marketplace.agent.outward.receipt";

/** Redacted, bounded argument preview for receipts (400 characters, like approvals' arguments_preview). */
export function receiptPreview(args: Record<string, unknown>) {
  const json = JSON.stringify(redactArguments(args));
  return json.length > 400 ? `${json.slice(0, 399)}…` : json;
}
