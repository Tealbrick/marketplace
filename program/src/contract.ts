import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import {
  APP_GRANT_INTROSPECT_PATH,
  assertManifest,
  companionResolverFromEnv,
  createContractHandler,
  createEmergencyLogin,
  createGrantGuard,
  createGrantVerifier,
  createSettingsSessions,
  EMERGENCY_BANNER,
  matchesFrontendRoute,
  verifyAny,
  type AuthRequest,
  type ContractAuditEvent,
  type ContractHandler,
  type CredentialResult,
  type CredentialVerifier,
  type EmergencyAuditEvent,
  type EmergencyLogin,
  type GrantCheck,
  type GrantResult,
  type Manifest,
  type OperationAuditEvent,
  type SettingsSessions,
  type SettingsSnapshot,
  type SettingsUpdate,
} from "@tealbrick/contract";

import manifestJson from "../../tealbrick.app.json" with { type: "json" };
import { marketplaceSecretMatches } from "./operator-auth.js";

/**
 * Teal Brick miniapp contract (`@tealbrick/contract`) for Marketplace.
 *
 * `tealbrick.app.json` at the repository root is the single manifest. It is validated here at start-up
 * (fail closed) and served at `/.well-known/tealbrick/manifest`. This module wires the kit's control
 * endpoints, the break-glass emergency login, the settings bearer sessions and the Portal app-grant gate
 * to Marketplace's existing identity. It adds no execution logic: the agent operations call the same
 * consented-call implementation as the Portal runtime receiver.
 */
export const MARKETPLACE_MANIFEST: Manifest = assertManifest(manifestJson);

export const MARKETPLACE_APP_ID = MARKETPLACE_MANIFEST.app.id;
export const MARKETPLACE_APP_MAJOR = MARKETPLACE_MANIFEST.app.major;

/** Agent-audience operations outside Channels (the channel ones are in channels/routes.ts). Every other declared operation has `audience: "owner"`. */
export const AGENT_OPERATION = Object.freeze({
  consentsList: "marketplace.consents.list",
  toolsCall: "marketplace.tools.call",
  approvalsResolve: "marketplace.approvals.resolve",
} as const);

export const PORTAL_APP_GRANT_PREFIX = "tbag_";

const ROUTE_SHAPE = /^\/(?![\/\\])[^\s#\\]{0,511}$/u;

/**
 * A Portal launch route is the app root or one of the manifest `frontend.routes` (home, settings or the
 * object template). Anything else is refused (contract 12.6.6). Returns the route to open, or null.
 */
export function resolveLaunchRoute(route: string | null | undefined): string | null {
  if (route === undefined || route === null || route === "" || route === "/") return "/";
  if (!ROUTE_SHAPE.test(route)) return null;
  return matchesFrontendRoute(MARKETPLACE_MANIFEST, route) ? route : null;
}

export function settingsRoute(): string {
  return MARKETPLACE_MANIFEST.frontend?.routes.settings ?? "/";
}

/** The instance credential(s) Portal holds for this deployment, checked in constant time. */
function instanceVerifier(secrets: () => ReadonlyArray<string | null | undefined>): CredentialVerifier {
  return Object.freeze({
    kind: "instance" as const,
    async verify(request: AuthRequest): Promise<CredentialResult> {
      const presented = [
        headerOf(request, "authorization")?.match(/^Bearer\s+(\S+)$/iu)?.[1],
        headerOf(request, "x-knowledge-instance-token"),
        headerOf(request, "x-tealbrick-instance-proof"),
      ].filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096);
      if (presented.length === 0) return { ok: false, reason: "missing_credential" };
      const configured = secrets().filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      for (const candidate of presented) {
        if (configured.some((secret) => marketplaceSecretMatches(candidate, secret))) {
          return { ok: true, credential: Object.freeze({ kind: "instance" as const, subject: "instance-operator" }) };
        }
      }
      return { ok: false, reason: "denied" };
    },
  });
}

function headerOf(request: AuthRequest, name: string): string | undefined {
  const headers = request.headers;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const value = (headers as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

export type MarketplaceSettingsStore = {
  read(): SettingsSnapshot | Promise<SettingsSnapshot>;
  write(update: SettingsUpdate, context: { readonly subject: string; readonly kind: string }): void | Promise<void>;
};

export type MarketplaceContractDeps = {
  readonly environment: Record<string, string | undefined>;
  readonly portal: {
    readonly issuerUrl: string | null;
    readonly deploymentId: string | null;
    readonly orgId: string | null;
    readonly workspaceId: string | null;
    readonly instanceProof: string | null;
  };
  /** The workspace binding (`TEALBRICK_TENANT_ID` equals `MARKETPLACE_ORGANIZATION_ID`). */
  readonly tenantId: string;
  /** Credentials Portal may present to the instance endpoints (internal token, instance token, instance proof). */
  readonly instanceSecrets: () => ReadonlyArray<string | null | undefined>;
  readonly settings: MarketplaceSettingsStore;
  /** Rules (optional companion) as configured for outbound governance; bound only when both are set. */
  readonly rules: { readonly baseUrl?: string; readonly internalAuthToken?: string } | null;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Production serves HTTPS only: `__Host-` Secure emergency cookie. Local http uses a plain cookie. */
  readonly secureCookies: boolean;
  readonly publicOrigin: string | null;
  /** Metadata-only audit sink (no tokens, no content). */
  readonly audit: (event: { readonly type: string; readonly outcome: string; readonly [key: string]: unknown }) => void;
};

/**
 * The kit turns any exception from a settings write into a generic 500. A write the app refuses on policy
 * (for example a provider address outside the allowed hosts) is a client error, so the write records the
 * refused keys here instead and applies nothing; the route then answers 400 `invalid_settings`.
 */
export const settingsRejections = new AsyncLocalStorage<string[]>();

/** Record keys of a settings write that was refused. Returns false outside a contract settings request. */
export function rejectSettingsKeys(keys: readonly string[]): boolean {
  const store = settingsRejections.getStore();
  if (!store) return false;
  store.push(...keys);
  return true;
}

export type MarketplaceGrantGate = {
  readonly configured: boolean;
  /** Verify the presented grant without naming an operation (the guidance endpoint). Null when Portal is not configured. */
  verify(request: AuthRequest): Promise<GrantResult | null>;
  check(request: { readonly method: string; readonly url: string; readonly headers: AuthRequest["headers"] }): Promise<GrantCheck | { readonly ok: false; readonly status: 503; readonly error: "portal_unconfigured"; readonly headers: Record<string, string> }>;
};

export type MarketplaceContract = {
  readonly manifest: Manifest;
  readonly handler: ContractHandler;
  readonly settingsSessions: SettingsSessions;
  readonly emergency: EmergencyLogin;
  readonly emergencyBanner: string;
  readonly emergencyCookieName: string;
  readonly grants: MarketplaceGrantGate;
};

export function createMarketplaceContract(deps: MarketplaceContractDeps): MarketplaceContract {
  const manifest = MARKETPLACE_MANIFEST;
  const settingsSessions = createSettingsSessions({ ...(deps.now ? { now: deps.now } : {}) });

  const emergencyCookieName = deps.secureCookies ? "__Host-tealbrick-emergency" : "tealbrick-emergency";
  const emergency = createEmergencyLogin({
    code: deps.environment.TEALBRICK_EMERGENCY_CODE?.trim() || undefined,
    sessionTtlMs: 15 * 60_000,
    cookie: { name: emergencyCookieName, secure: deps.secureCookies },
    ...(deps.publicOrigin ? { origins: [deps.publicOrigin] } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    audit: (event: EmergencyAuditEvent) =>
      deps.audit({
        type: `marketplace.auth.${event.type}`,
        outcome: event.outcome,
        client: event.client,
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.expiresAt ? { expiresAt: new Date(event.expiresAt).toISOString() } : {}),
      }),
  });

  // The 5-minute settings bearer (minted at Portal launch) or a live emergency owner session may use the
  // settings endpoint, so the owner can fix settings while Portal is down.
  const settingsAuth: CredentialVerifier = Object.freeze({
    kind: "settings" as const,
    verify: (request: AuthRequest) => verifyAny([settingsSessions.verifier, emergency.enabled ? emergency.verifier : undefined], request),
  });

  const handler = createContractHandler({
    manifest,
    health: () => true,
    status: async () => {
      const snapshot = await deps.settings.read();
      return { setup: "configured", settingsRevision: snapshot.revision };
    },
    settings: deps.settings,
    companions: companionResolverFromEnv(manifest, {
      TEALBRICK_COMPANION_RULES_APPROVALS_URL: deps.rules?.baseUrl,
      TEALBRICK_COMPANION_RULES_APPROVALS_TOKEN: deps.rules?.internalAuthToken,
    }),
    auth: { instance: instanceVerifier(deps.instanceSecrets), settings: settingsAuth },
    ...(deps.portal.issuerUrl ? { cors: { origins: [deps.portal.issuerUrl] } } : {}),
    audit: (event: ContractAuditEvent) =>
      deps.audit({
        type: `marketplace.contract.${event.endpoint}`,
        outcome: event.outcome,
        method: event.method,
        ...(event.credential ? { credential: event.credential } : {}),
        ...(event.keys ? { keys: [...event.keys] } : {}),
      }),
  });

  let guard: ReturnType<typeof createGrantGuard> | null | undefined;
  let grantVerifier: ReturnType<typeof createGrantVerifier> | null = null;
  const grantGuard = () => {
    if (guard !== undefined) return guard;
    const portal = deps.portal;
    if (!portal.issuerUrl || !portal.deploymentId || !portal.instanceProof) {
      guard = null;
      return guard;
    }
    try {
      const verifier = createGrantVerifier({
        mode: "l1",
        manifest,
        ...(portal.workspaceId ? { expectedWorkspaceId: portal.workspaceId } : {}),
        introspect: {
          wire: "app-grant-v1",
          url: `${portal.issuerUrl}${APP_GRANT_INTROSPECT_PATH}`,
          deploymentId: portal.deploymentId,
          product: MARKETPLACE_APP_ID,
          instanceProof: portal.instanceProof,
          // Core answers `productTenantId`; the kit requires it to equal the tenant binding.
          tenantId: deps.tenantId,
          ...(portal.orgId ? { orgId: portal.orgId } : {}),
          ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
        ...(deps.now ? { now: deps.now } : {}),
      });
      grantVerifier = verifier;
      guard = createGrantGuard({
        verifier,
        manifest,
        unknownRoutes: "deny",
        audit: (event: OperationAuditEvent) =>
          deps.audit({
            type: "marketplace.agent.operation_denied",
            outcome: "denied",
            operation: event.operation,
            status: event.status,
            error: event.error,
            ...(event.principal ? { principal: event.principal } : {}),
          }),
      });
    } catch {
      // An unusable Portal binding never degrades to "allow".
      guard = null;
    }
    return guard;
  };

  const grants: MarketplaceGrantGate = {
    get configured() {
      return grantGuard() !== null;
    },
    async verify(request) {
      return grantGuard() && grantVerifier ? grantVerifier.verifyGrant(request) : null;
    },
    async check(request) {
      const active = grantGuard();
      if (!active) return { ok: false, status: 503, error: "portal_unconfigured", headers: {} };
      return active.check(request);
    },
  };

  return { manifest, handler, settingsSessions, emergency, emergencyBanner: EMERGENCY_BANNER, emergencyCookieName, grants };
}

/** A stable settings revision: changes whenever a served value or a secret presence changes. */
export function settingsRevision(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}
