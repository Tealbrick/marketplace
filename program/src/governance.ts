import type { ConnectorCapability, RulesClient } from "./types.js";

/**
 * How Marketplace decides governed actions.
 *
 * - `rules`: a Rules service is configured (RULES_BASE_URL or an injected
 *   client). Every governed action is evaluated by Rules and fails closed when
 *   Rules is unreachable or misconfigured.
 * - `owner`: no Rules service is configured. The workspace owner approves
 *   their own installs and actions through their authenticated operator
 *   session; agents act only through consent attested by Teal Brick Portal.
 *
 * Owner mode is chosen from configuration only. A configured Rules service that
 * is down never falls back to owner mode.
 */
export type GovernanceMode = "rules" | "owner";

/** How an agent's authority was proven before reaching the governance gate. */
export type AgentAttestation =
  /** Execute carrying a stored agent grant whose Portal scope was re-verified. */
  | "agent-grant"
  /** Agent grant creation after Portal agent + attachment scope verification. */
  | "portal-scope"
  /** Portal handoff consent redeemed from Portal for this deployment. */
  | "portal-consent"
  /** Runtime receiver call carrying a verified Portal consent and lease. */
  | "runtime-lease"
  /**
   * Channel send whose outward authority is an owner approval: the owner
   * approved this exact payload digest, or approved the standing grant that
   * covers it (Channels spec §4.4, §6 3c). Set only by the channel path after
   * that authority is resolved, never from request input.
   */
  | "owner-approval"
  /**
   * Outward connector execute in owner mode under the owner's per-agent
   * Assistant setting (agent-modes.ts): not sensitive, within the daily
   * limits, receipt reserved. Set only by the execution path after reading the
   * owner-written setting, never from request input.
   */
  | "assistant-mode";

/**
 * The authenticated actor behind a governed action, resolved from the request
 * principal or from a Portal attestation, never from a client-supplied actorId.
 */
export type GovernanceActor =
  | { kind: "operator"; id: string }
  | { kind: "service"; id: string }
  | { kind: "agent"; id: string; attestation: AgentAttestation };

export function governanceModeFor(input: {
  rulesClient?: RulesClient;
  rulesConfigured: boolean;
}): GovernanceMode {
  return input.rulesClient || input.rulesConfigured ? "rules" : "owner";
}

export const OWNER_APPROVAL_REQUIRES_PORTAL_CONSENT =
  "owner_approval_requires_portal_consent" as const;

export const OWNER_APPROVAL_REQUIRED_FOR_OUTWARD =
  "owner_approval_required_for_outward" as const;

/**
 * What a governed execute would do, declared by the connector (Company Box
 * entries flag writes, destructive and outward operations). Sent to Rules in
 * the payload as `risk`; owner mode uses `outward` to require the owner.
 */
export type GovernedActionRisk = {
  write: boolean;
  /** Reaches people or systems outside the workspace (send, publish, email). */
  outward: boolean;
  destructive: boolean;
};

export type OwnerGovernedDecision =
  | {
      effect: "allow";
      decisionId: string;
      reason: string;
      basis: "operator" | "service-admin" | "portal-consent" | "owner-approval" | "assistant-mode";
    }
  | {
      effect: "deny";
      error:
        | typeof OWNER_APPROVAL_REQUIRES_PORTAL_CONSENT
        | typeof OWNER_APPROVAL_REQUIRED_FOR_OUTWARD;
      reason: string;
    };

/**
 * Owner approval mode decision. Pure: callers record the audit event.
 *
 * - Operator session: the owner is acting directly, so every governed
 *   operation (lifecycle, connect, bind, custom MCP admin, execute) is allowed.
 * - Agent with Portal attestation: allowed; the consent was granted in Portal.
 * - Internal service bearer without Portal attestation: allowed only for
 *   connector administration (`connector.admin`, e.g. Hub lifecycle routes),
 *   because the bearer is owner-provisioned infrastructure. Anything that
 *   executes, dispatches or delegates connector actions is denied.
 * - No authenticated actor: denied.
 * - Outward execute (`risk.outward`): only the owner's operator session may
 *   run it. Portal consent covers routine reads and writes, not sending or
 *   publishing on the owner's behalf; that needs the owner each time, or a
 *   Rules service whose approvals queue reviews it.
 */
export function ownerGovernedDecision(input: {
  operation: string;
  capability: ConnectorCapability;
  pluginId: string;
  actor: GovernanceActor | null;
  risk?: GovernedActionRisk;
}): OwnerGovernedDecision {
  const { actor, operation, pluginId } = input;
  if (actor?.kind === "agent" && actor.attestation === "owner-approval" && operation === "execute") {
    return {
      effect: "allow",
      decisionId: `owner-governed:owner-approval:${operation}:${pluginId}`,
      reason: "Outward action approved by the workspace owner (exact payload approval or owner-approved standing grant).",
      basis: "owner-approval",
    };
  }
  if (actor?.kind === "agent" && actor.attestation === "assistant-mode" && operation === "execute") {
    return {
      effect: "allow",
      decisionId: `owner-governed:assistant-mode:${operation}:${pluginId}`,
      reason: "Outward action run under the owner's Assistant setting for this agent (receipt in Activity).",
      basis: "assistant-mode",
    };
  }
  if (input.risk?.outward && operation === "execute" && actor?.kind !== "operator") {
    return {
      effect: "deny",
      error: OWNER_APPROVAL_REQUIRED_FOR_OUTWARD,
      reason:
        "Outward actions (sending, publishing) need the owner's approval: run it from Marketplace, or connect Rules approvals.",
    };
  }
  if (actor?.kind === "operator") {
    return {
      effect: "allow",
      decisionId: `owner-governed:${operation}:${pluginId}`,
      reason: "Approved by the workspace owner's operator session (owner approval mode).",
      basis: "operator",
    };
  }
  if (actor?.kind === "agent") {
    return {
      effect: "allow",
      decisionId: `owner-governed:portal-consent:${operation}:${pluginId}`,
      reason: "Agent action covered by consent granted in Teal Brick Portal (owner approval mode).",
      basis: "portal-consent",
    };
  }
  if (
    actor?.kind === "service" &&
    input.capability === "connector.admin" &&
    operation !== "execute"
  ) {
    return {
      effect: "allow",
      decisionId: `owner-governed:${operation}:${pluginId}`,
      reason: "Owner-provisioned service administration (owner approval mode).",
      basis: "service-admin",
    };
  }
  return {
    effect: "deny",
    error: OWNER_APPROVAL_REQUIRES_PORTAL_CONSENT,
    reason:
      "Without a Rules service, agents and services can act only with consent granted in Teal Brick Portal.",
  };
}
