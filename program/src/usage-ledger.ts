import type { ConnectorPromotionCandidate, ConnectorUsageLedgerEntry } from "./types.js";

import { createHash } from "node:crypto";

/** Largest output Marketplace stores verbatim (usage evidence, approval results). */
export const STORED_OUTPUT_MAX_BYTES = 64 * 1024;

export type StoredOutputDigest = { bytes: number; sha256: string };

export function outputDigest(value: unknown): StoredOutputDigest {
  const json = JSON.stringify(value ?? null);
  return { bytes: Buffer.byteLength(json), sha256: createHash("sha256").update(json).digest("hex") };
}

/**
 * Keep an output for storage: verbatim up to 64 KB, otherwise a marker with
 * the full output's byte length and sha256 so the evidence stays verifiable.
 */
export function boundedStoredOutput(value: unknown, maxBytes = STORED_OUTPUT_MAX_BYTES) {
  const digest = outputDigest(value);
  return digest.bytes <= maxBytes
    ? { output: value, truncated: false as const, ...digest }
    : { output: { truncated: true, ...digest }, truncated: true as const, ...digest };
}

export function shapeOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      Array.isArray(nested) ? "array" : nested === null ? "null" : typeof nested,
    ]),
  );
}

export function scanConnectorPromotionCandidates(
  entries: ConnectorUsageLedgerEntry[],
  input?: { threshold?: number },
): ConnectorPromotionCandidate[] {
  const threshold = Math.max(1, input?.threshold ?? 3);
  const groups = new Map<string, ConnectorUsageLedgerEntry[]>();
  for (const entry of entries.filter((item) => item.status === "succeeded")) {
    const key = `${entry.workspaceSlug}:${entry.provider}:${entry.sourceActionKey}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.values()]
    .filter((group) => group.length >= threshold)
    .map((group) => {
      const sorted = [...group].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const first = sorted[0]!;
      const last = sorted.at(-1)!;
      const recommendedState: ConnectorPromotionCandidate["recommendedState"] =
        group.length >= threshold * 2 ? "contract_defined" : "promotion_candidate";
      return {
        id: `promotion:${first.workspaceSlug}:${first.provider}:${first.sourceActionKey}`,
        workspaceSlug: first.workspaceSlug,
        provider: first.provider,
        sourceActionKey: first.sourceActionKey,
        productCapabilityKey: first.productCapabilityKey,
        usageCount: group.length,
        firstSeenAt: first.createdAt,
        lastSeenAt: last.createdAt,
        sampleLedgerEntryIds: sorted.slice(-5).map((entry) => entry.id),
        commonInputShape: first.inputShape,
        commonOutputShape: first.outputShape,
        recommendedState,
      };
    })
    .sort((left, right) => right.usageCount - left.usageCount || right.lastSeenAt.localeCompare(left.lastSeenAt));
}
