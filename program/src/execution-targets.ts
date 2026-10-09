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
};

export type ExecutionPreparation =
  | { ok: true; prepared: PreparedExecution }
  | { ok: false; statusCode: number; error: string };

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
