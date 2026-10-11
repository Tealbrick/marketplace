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
 */
import type { GovernedActionRisk } from "./governance.js";
import type { ConnectorCapability } from "./types.js";

export type AgentApprovalMode = "assistant" | "system";

export const DEFAULT_AGENT_DAILY_CAP = 100;
export const DEFAULT_AGENT_CONNECTOR_DAILY_CAP = 50;
export const MAX_AGENT_DAILY_CAP = 10_000;

export type SensitiveFamily = "destructive" | "money" | "access" | "bulk";

/**
 * The words that keep an outward action held in Assistant mode (System mode holds every outward action anyway).
 * Matched against the tool name's word segments (Composio `GMAIL_SEND_EMAIL` style, custom MCP `send_message` or
 * `sendMessage`), case-insensitive, as whole segments. `BULK_*` / `MASS_*`: the segment followed by another one;
 * `*_ALL`: the last segment `ALL` after another one. The owner UI renders this list ("What still waits?").
 */
export const SENSITIVE_ACTION_FAMILIES: ReadonlyArray<{
  readonly family: SensitiveFamily;
  readonly label: string;
  readonly words: readonly string[];
}> = Object.freeze(([
  {
    family: "destructive",
    label: "Deletes and resets",
    words: ["DELETE", "REMOVE", "PURGE", "WIPE", "TRASH", "EMPTY", "OVERWRITE", "REPLACE_ALL", "REVOKE", "DISABLE", "BAN", "KICK", "RESET", "ARCHIVE_ALL"],
  },
  {
    family: "money",
    label: "Payments and refunds",
    words: ["PAY", "CHARGE", "TRANSFER", "PAYOUT", "PURCHASE", "ORDER", "SUBSCRIBE", "CANCEL_SUBSCRIPTION", "REFUND"],
  },
  {
    family: "access",
    label: "Sharing and permissions",
    words: [
      "SHARE", "INVITE", "ADD_MEMBER", "GRANT", "SET_PERMISSION", "UPDATE_PERMISSIONS", "CHANGE_OWNER", "TRANSFER_OWNERSHIP",
      "FORWARD", "CREATE_API_KEY", "CREATE_TOKEN", "ADD_WEBHOOK", "CREATE_FORWARDING_RULE", "CREATE_FILTER",
    ],
  },
  {
    family: "bulk",
    label: "Bulk and broadcast",
    words: ["BULK_*", "*_ALL", "SEND_TO_ALL", "BROADCAST", "MASS_*"],
  },
] as Array<{ family: SensitiveFamily; label: string; words: string[] }>).map((entry) =>
  Object.freeze({ ...entry, words: Object.freeze([...entry.words]) }),
));

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

function containsRun(segments: readonly string[], run: readonly string[]) {
  for (let start = 0; start + run.length <= segments.length; start += 1) {
    if (run.every((segment, offset) => segments[start + offset] === segment)) return true;
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

export type AssistantHoldReason =
  | { reason: "destructive" }
  | { reason: "admin" }
  | { reason: "sensitive"; family: SensitiveFamily; word: string };

/**
 * Why an outward call stays held in Assistant mode, or null when it may run. Curated destructive flags,
 * `connector.admin` (destructive by name or hint), then the sensitive families by tool name.
 */
export function assistantHoldReason(input: {
  risk: GovernedActionRisk;
  capability: ConnectorCapability;
  toolName: string;
  toolkit?: string;
}): AssistantHoldReason | null {
  if (input.risk.destructive) return { reason: "destructive" };
  if (input.capability === "connector.admin") return { reason: "admin" };
  const match = sensitiveMatches(input.toolName, input.toolkit)[0];
  return match ? { reason: "sensitive", family: match.family, word: match.word } : null;
}

export function holdReasonCode(reason: AssistantHoldReason) {
  return reason.reason === "sensitive" ? `sensitive:${reason.family}` : reason.reason;
}

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
