import { createServer } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";

const mode = process.env.SMOKE_MODE ?? "setup";
const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:5314";
const organizationId = process.env.SMOKE_ORGANIZATION_ID ?? "smoke-org";
const deploymentId = "deployment-smoke";
const agentId = "agent-smoke";
const portalOrgId = "portal-org-smoke";
const portalIssuer =
  process.env.SMOKE_PORTAL_ISSUER ?? "http://host.docker.internal:5317";
const internalToken = process.env.SMOKE_INTERNAL_TOKEN ?? "smoke-internal-token";
const selection = {
  pluginId: "github-composio",
  actionKey: "github.list.repositories",
  accountId: "ca_smoke",
  resourceKind: "github.connected-account",
  resourceRef: "account:ca_smoke",
};

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const publicJwk = publicKey.export({ format: "jwk" });
const leaseId = "lease-smoke";
const consentId = "consent-smoke";
const nowSeconds = Math.floor(Date.now() / 1_000);

let composioExecuteCalls = 0;
let portalGrantRedeemCalls = 0;

function json(value) {
  return JSON.stringify(value);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function response(status, body) {
  return { status, body };
}

async function listen(port, handler) {
  const server = createServer(async (request, rawResponse) => {
    try {
      const body = await requestBody(request);
      const result = await handler({
        method: request.method ?? "GET",
        path: new URL(request.url ?? "/", "http://smoke.invalid").pathname,
        body,
        headers: request.headers,
      });
      rawResponse.statusCode = result.status;
      rawResponse.setHeader("content-type", "application/json");
      rawResponse.end(json(result.body));
    } catch (error) {
      rawResponse.statusCode = 500;
      rawResponse.setHeader("content-type", "application/json");
      rawResponse.end(json({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(port, "0.0.0.0", resolve));
  return server;
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function portalConsent() {
  return {
    schema: 1,
    authorized: true,
    product: "marketplace",
    portalOrgId,
    productTenantId: organizationId,
    workspaceId: organizationId,
    deploymentId,
    userId: "user-smoke",
    agentId,
    consentId,
    consentRevision: 1,
    state: "active",
    capabilities: ["connector.observe"],
    requiredActions: ["read"],
    selection,
  };
}

function decodeJwtClaims(token) {
  const [, encodedClaims] = token.split(".");
  return JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"));
}

function makeLease() {
  const claims = {
    iss: portalIssuer,
    aud: "marketplace",
    typ: "attachment",
    purpose: "marketplace-runtime",
    status: "active",
    iat: nowSeconds - 5,
    exp: nowSeconds + 120,
    deploymentId,
    sub: agentId,
    consentId,
    jti: leaseId,
    orgId: portalOrgId,
    productTenantId: organizationId,
    workspaceId: organizationId,
    capabilities: ["connector.observe"],
  };
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", typ: "JWT", kid: "smoke-key" }),
  ).toString("base64url");
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signedBytes = `${header}.${encodedClaims}`;
  const signature = sign("sha256", Buffer.from(signedBytes), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signedBytes}.${signature}`;
}

async function appRequest(path, options = {}) {
  const requestPayload =
    options.body && typeof options.body !== "string"
      ? JSON.stringify(options.body)
      : options.body;
  const result = await fetch(`${baseUrl}${path}`, {
    ...options,
    body: requestPayload,
    headers: {
      accept: "application/json",
      ...(requestPayload !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await result.text();
  let responseBody = null;
  try {
    responseBody = text ? JSON.parse(text) : null;
  } catch {
    responseBody = text;
  }
  return { status: result.status, body: responseBody, headers: result.headers };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertStatus(result, expected, label) {
  assert(result.status === expected, `${label}: expected ${expected}, got ${result.status}: ${json(result.body)}`);
}

async function startMocks() {
  const rulesServer = await listen(5315, async ({ path }) => {
    if (path === "/api/rules/gateway/evaluate") {
      return response(200, { effect: "allow", decisionId: "rules-smoke-allow" });
    }
    return response(404, { error: "not_found" });
  });
  const composioServer = await listen(5316, async ({ method, path }) => {
    if (path === "/v3.1/tools" || path === "/v3/tools") {
      return response(200, { items: [{ name: "GITHUB_LIST_REPOSITORIES" }] });
    }
    if (path === "/v3.1/auth_configs" && method === "GET") {
      return response(200, { items: [{ id: "auth-config-smoke", toolkit: { slug: "github" } }] });
    }
    if (path === "/v3/connected_accounts/link" && method === "POST") {
      return response(200, { connected_account_id: "ca_smoke", status: "ACTIVE" });
    }
    if (path === "/v3/tools/execute/GITHUB_LIST_REPOSITORIES" && method === "POST") {
      composioExecuteCalls += 1;
      return response(200, {
        data: [{ name: "marketplace-smoke" }],
        access_token: "provider-secret-smoke",
      });
    }
    return response(200, { items: [] });
  });
  const portalServer = await listen(5317, async ({ method, path, body }) => {
    if (path === "/api/jwks") {
      return response(200, { keys: [{ ...publicJwk, kid: "smoke-key", alg: "ES256", use: "sig" }] });
    }
    if (path === "/api/deployment-browser/redeem" && method === "POST") {
      return response(200, {
        schema: 1,
        authorized: true,
        product: "marketplace",
        deploymentId,
        workspaceId: organizationId,
        orgId: portalOrgId,
        productTenantId: organizationId,
        userId: "user-smoke",
        endpoint: portalIssuer,
        session: "s".repeat(43),
        expiresAt: Date.now() + 600_000,
      });
    }
    if (path === "/api/deployment-browser/grant-request" && method === "POST") {
      return response(200, {
        requestId: "r".repeat(43),
        approvalUrl: `${portalIssuer}/approval/smoke`,
        expiresAt: Date.now() + 600_000,
      });
    }
    if (path === "/api/deployment-browser/grant-redeem" && method === "POST") {
      portalGrantRedeemCalls += 1;
      if (process.env.SMOKE_REDEEM_FAILURE_ONCE === "1" && portalGrantRedeemCalls === 1) {
        return response(503, { error: "portal_upstream_timeout" });
      }
      return response(200, portalConsent());
    }
    if (path === "/api/deployment-browser/grant-receipt" && method === "POST") {
      return response(200, portalConsent());
    }
    if (path === "/api/deployment-browser/grant-introspect" && method === "POST") {
      const claims = decodeJwtClaims(String(body.attachment ?? ""));
      return response(200, {
        schema: 1,
        authorized: true,
        portalOrgId: claims.orgId,
        productTenantId: claims.productTenantId,
        workspaceId: claims.workspaceId,
        deploymentId: claims.deploymentId,
        agentId: claims.sub,
        consentId: claims.consentId,
        consentRevision: 1,
        leaseId: claims.jti,
        capabilities: claims.capabilities,
        expiresAt: claims.exp * 1_000,
      });
    }
    return response(404, { error: "not_found" });
  });
  return { rulesServer, composioServer, portalServer };
}

async function setup() {
  const serviceHeaders = { authorization: `Bearer ${internalToken}` };
  const launch = await appRequest(
    `/auth/launch?ticket=${"t".repeat(43)}&deploymentId=${deploymentId}`,
  );
  assertStatus(launch, 200, "Portal launch");

  const imported = await appRequest("/api/marketplace/catalog/composio/import", {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify({
      workspaceSlug: organizationId,
      actorId: "operator",
      toolkit: "github",
      pluginId: "github-composio",
      tools: [{ name: "GITHUB_LIST_REPOSITORIES" }],
      autoEnable: true,
    }),
  });
  assertStatus(imported, 201, "Composio import");

  const connection = await appRequest("/api/marketplace/plugins/github-composio/connection", {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify({
      workspaceSlug: organizationId,
      actorId: "operator",
      provider: "github",
      toolkit: "github",
      backend: "composio",
      userId: "user-smoke",
    }),
  });
  assertStatus(connection, 200, "Composio connection");
  assert(connection.body?.connection?.state === "connected", "Composio connection was not connected");

  const requestBody = {
    deploymentId,
    agentId,
    selection,
    idempotencyKey: "smoke-grant-idempotency-1",
  };
  const grantRequest = await appRequest("/api/marketplace/v1/agent/grants/request", {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify(requestBody),
  });
  assertStatus(grantRequest, 200, "Portal grant request");
  const duplicateGrantRequest = await appRequest("/api/marketplace/v1/agent/grants/request", {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify(requestBody),
  });
  assertStatus(duplicateGrantRequest, 200, "duplicate Portal grant request");
  assert(
    grantRequest.body?.request?.requestId === duplicateGrantRequest.body?.request?.requestId,
    "duplicate Portal grant request did not reconcile to the same request",
  );

  const requestId = grantRequest.body.request.requestId;
  const redeem = await appRequest("/api/marketplace/v1/agent/grants/redeem", {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify({ deploymentId, requestId }),
  });
  assertStatus(redeem, 200, "Portal grant redeem/receipt reconciliation");
  assert(redeem.body?.reconciled === true, "uncertain Portal write did not reconcile through receipt");
  const duplicateRedeem = await appRequest("/api/marketplace/v1/agent/grants/redeem", {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify({ deploymentId, requestId }),
  });
  assertStatus(duplicateRedeem, 200, "duplicate Portal grant redeem");
  assert(duplicateRedeem.body?.created === false, "duplicate grant redeem created a second consent");

  const lease = makeLease();
  const runtimeBody = {
    schema: 1,
    consentId,
    selection,
    input: { per_page: 1 },
    idempotencyKey: "smoke-runtime-idempotency-1",
  };
  const runtime = await appRequest("/api/marketplace/v1/runtime/composio/execute", {
    method: "POST",
    headers: { authorization: `Bearer ${lease}` },
    body: JSON.stringify(runtimeBody),
  });
  assertStatus(runtime, 200, "Portal runtime execution");
  assert(runtime.body?.result?.details?.result?.access_token === "[redacted]", "provider secret was not redacted");
  const replay = await appRequest("/api/marketplace/v1/runtime/composio/execute", {
    method: "POST",
    headers: { authorization: `Bearer ${lease}` },
    body: JSON.stringify(runtimeBody),
  });
  assertStatus(replay, 200, "runtime idempotent replay");
  assert(replay.body?.replayed === true, "runtime retry was not marked replayed");
  assert(composioExecuteCalls === 1, `runtime retry dispatched ${composioExecuteCalls} provider calls`);

  const consentRecordId = redeem.body?.consent?.id;
  assert(typeof consentRecordId === "string" && consentRecordId, "redeem did not return durable consent id");
  const revoked = await appRequest(`/api/marketplace/agent/grants/${encodeURIComponent(consentRecordId)}/revoke`, {
    method: "POST",
    headers: serviceHeaders,
  });
  assertStatus(revoked, 200, "Portal consent revoke");
  const afterRevoke = await appRequest("/api/marketplace/v1/runtime/composio/execute", {
    method: "POST",
    headers: { authorization: `Bearer ${lease}` },
    body: JSON.stringify({ ...runtimeBody, idempotencyKey: "smoke-runtime-after-revoke" }),
  });
  assertStatus(afterRevoke, 403, "revoked Portal runtime");
  assert(afterRevoke.body?.error === "runtime_consent_revoked", "revoked Portal runtime was not denied");
}

async function verifyAfterRestore() {
  const serviceHeaders = { authorization: `Bearer ${internalToken}` };
  const status = await appRequest("/api/status", { headers: serviceHeaders });
  assertStatus(status, 200, "status after restore");
  const plugins = await appRequest(`/api/marketplace/plugins?workspaceSlug=${organizationId}`, {
    headers: serviceHeaders,
  });
  assertStatus(plugins, 200, "plugins after restore");
  const github = plugins.body?.items?.find((item) => item.pluginId === "github-composio");
  assert(github?.install?.lifecycle === "installed", "installed connector did not persist after restore");
  assert(github?.connection?.state === "connected", "connected account did not persist after restore");

  const grantRequest = await appRequest("/api/marketplace/v1/agent/grants/request", {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify({
      deploymentId,
      agentId,
      selection,
      idempotencyKey: "smoke-grant-idempotency-1",
    }),
  });
  assertStatus(grantRequest, 200, "encrypted Portal session after restore");
  const lease = makeLease();
  const revoked = await appRequest("/api/marketplace/v1/runtime/composio/execute", {
    method: "POST",
    headers: { authorization: `Bearer ${lease}` },
    body: {
      schema: 1,
      consentId,
      selection,
      input: { per_page: 1 },
      idempotencyKey: "smoke-runtime-after-restore",
    },
  });
  assertStatus(revoked, 403, "revoked Portal runtime after restore");
  assert(revoked.body?.error === "runtime_consent_revoked", "revocation did not persist after restore");
}

const mocks = await startMocks();
try {
  if (mode === "setup") await setup();
  else if (mode === "verify") await verifyAfterRestore();
  else throw new Error(`Unknown SMOKE_MODE ${mode}`);
  process.stdout.write(`${mode} image contract smoke passed\n`);
} finally {
  await Promise.all(Object.values(mocks).map(close));
}
