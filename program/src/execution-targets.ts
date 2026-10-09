// Execution targets for executeConsentedCall. A target turns one consented,
// rules-approved call into a provider call. The consent, rules, idempotency,
// usage-ledger and audit steps stay in executeConsentedCall; a target only
// prepares its outbound call (before the idempotency key is reserved, so a
// preparation failure never leaves an operation needing reconciliation) and
// then runs it.

export type PreparedExecution = {
  toolName: string;
  summary: string;
  run: () => Promise<unknown>;
  /**
   * Undo what `prepare` reserved when the idempotency step refuses the call
   * (replay, conflict or in progress), so nothing stays consumed. Optional;
   * the connector targets reserve nothing.
   */
  release?: () => void;
};

export type ExecutionPreparation =
  | { ok: true; prepared: PreparedExecution }
  | { ok: false; statusCode: number; error: string; detail?: Record<string, unknown> };

/**
 * Thrown by a target's `run` when it knows the outcome is not a success:
 * `failed` (nothing was delivered) or `uncertain` (it may have been). The
 * shared tail records it like any failure, with this code, HTTP status,
 * runtime-operation status and output (e.g. a channel receipt). Any other
 * throw keeps the existing "reconciliation required" handling.
 */
export class ConsentedExecutionOutcome extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly operationStatus: "succeeded" | "reconciliation-required",
    readonly output: unknown,
    readonly detail?: string,
  ) {
    super(code);
    this.name = "ConsentedExecutionOutcome";
  }
}

export type ExecutionTarget<Context> = {
  id: string;
  matches: (context: Context) => boolean;
  prepare: (context: Context) => ExecutionPreparation;
};

// First match wins; the last target should match everything (the default).
export function selectExecutionTarget<Context>(
  targets: readonly ExecutionTarget<Context>[],
  context: Context,
): ExecutionTarget<Context> {
  const target = targets.find((candidate) => candidate.matches(context));
  if (!target) throw new Error("execution_target_unresolved");
  return target;
}
