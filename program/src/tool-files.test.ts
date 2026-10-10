/**
 * Tool files (#59): `marketplace.tool-files.upload` and file references in
 * `marketplace.tools.call`, end to end through the real app against the
 * shipped Nextcloud and Postiz Company Box entries and a fake REST server.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { DEFAULT_COMPANY_BOX_CATALOG_DIR } from "./company-box.js";
import { AGENT_OPERATION } from "./contract.js";
import { MARKETPLACE_OPERATOR_SESSION_COOKIE, MarketplaceOperatorSessionManager } from "./operator-auth.js";
import { SqliteMarketplaceStore } from "./store.js";
import { startFakeRestServer } from "./testing/fake-rest-server.js";
import {
  checkToolFileType,
  fileArgumentPaths,
  findToolFileRefs,
  TOOL_FILE_QUOTA_FILES,
  TOOL_FILES_SUBDIR,
  ToolFileError,
} from "./tool-files.js";

const PORTAL = "https://portal.test";
const ORIGIN = "https://marketplace.fixture.invalid";
const SERVICE = "marketplace-service-secret";
const TENANT = "tenant-community";
const GRANT_A = `tbag_${"a".repeat(43)}`;
const GRANT_B = `tbag_${"b".repeat(43)}`;
const GRANT_CALL_ONLY = `tbag_${"c".repeat(43)}`;
const SECRET = "cb-tool-files-secret-0001";
const USER = "api-user";
const NEXTCLOUD = "company-box-nextcloud";
const POSTIZ = "company-box-postiz";
const NC_UPLOAD = "company-box-nextcloud.webdav-files-upload";
const NC_PROPFIND = "company-box-nextcloud.webdav-files-propfind";
const POSTIZ_UPLOAD = "company-box-postiz.public-integrations-controller-upload-simple";
const HOUR = 3_600_000;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-fixture-image-bytes")]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....[Content_Types].xml....word/document.xml")]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("plain-archive-entry")]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => {
  vi.restoreAllMocks();
});

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

async function fixture(input: { maxUploadBytes?: number } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "marketplace-tool-files-"));
  const store = new SqliteMarketplaceStore(path.join(root, "data", "marketplace.sqlite"), { handoffEncryptionKey: "a".repeat(64) });
  const rest = await startFakeRestServer({
    authorize: (request) =>
      request.headers.authorization === `Basic ${Buffer.from(`${USER}:${SECRET}`).toString("base64")}` || request.headers.authorization === SECRET,
  });
  let clock = Date.now();
  const grants: Record<string, { agentId: string; operations: string[] }> = {
    [GRANT_A]: { agentId: "agent-1", operations: [AGENT_OPERATION.toolsCall, AGENT_OPERATION.toolFilesUpload, AGENT_OPERATION.consentsList] },
    [GRANT_B]: { agentId: "agent-2", operations: [AGENT_OPERATION.toolsCall, AGENT_OPERATION.toolFilesUpload, AGENT_OPERATION.consentsList] },
    [GRANT_CALL_ONLY]: { agentId: "agent-1", operations: [AGENT_OPERATION.toolsCall] },
  };
  const portalFetch: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (String(url).endsWith("/api/runtime/app-grant/introspect")) {
      const grant = grants[String(body.token)];
      if (!grant) return new Response(JSON.stringify({ error: "app_grant_denied" }), { status: 403 });
      return new Response(
        JSON.stringify({
          authorized: true,
          principalId: `tealbrick-agent:${grant.agentId}`,
          agentId: grant.agentId,
          orgId: "portal-org-1",
          workspaceId: TENANT,
          deploymentId: "deployment-1",
          product: "marketplace",
          productTenantId: TENANT,
          actions: ["create", "read", "update"],
          operations: grant.operations,
          capabilityRevision: 1,
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  };
  const sessions = new MarketplaceOperatorSessionManager({ accessToken: "marketplace-operator-token-1234" });
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: SERVICE,
    organizationId: TENANT,
    operatorSessionManager: sessions,
    env: {},
    environment: {
      NODE_ENV: "test",
      MARKETPLACE_ORGANIZATION_ID: TENANT,
      MARKETPLACE_PORTAL_URL: `${PORTAL}/`,
      MARKETPLACE_PORTAL_INSTANCE_TOKEN: "p".repeat(43),
      MARKETPLACE_PORTAL_DEPLOYMENT_ID: "deployment-1",
      MARKETPLACE_PORTAL_ORG_ID: "portal-org-1",
      MARKETPLACE_PORTAL_WORKSPACE_ID: TENANT,
      MARKETPLACE_ALLOWED_ORIGINS: ORIGIN,
      MARKETPLACE_MCP_ALLOWED_ORIGINS: rest.origin,
      ...(input.maxUploadBytes ? { MARKETPLACE_COMPANY_BOX_MAX_UPLOAD_BYTES: String(input.maxUploadBytes) } : {}),
    },
    portalFetch,
    mcpFetch: (resource, init) => fetch(resource, init),
    companyBoxCatalogDir: DEFAULT_COMPANY_BOX_CATALOG_DIR,
    toolFileClock: () => new Date(clock),
    channelScheduler: false,
  });
  open.push(async () => {
    await app.close();
    store.close();
    await rest.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { token, status } = sessions.issuePortalSession({ id: "operator-1", organizationId: TENANT });
  const operator = {
    cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    origin: ORIGIN,
    "x-csrf-token": status.csrfToken!,
  };
  for (const [id, credentials] of [
    ["nextcloud", { username: USER, password: SECRET }],
    ["postiz", { token: SECRET }],
  ] as const) {
    const setup = await app.inject({ method: "POST", url: `/api/marketplace/company-box/${id}/setup`, headers: operator, payload: { baseUrl: rest.origin, credentials } });
    expect(setup.statusCode, setup.body).toBe(200);
  }
  const consentFor = (agentId: string, consentId: string, pluginId: string, actionKey: string) =>
    store.createMarketplaceAgentConsent({
      portalIssuer: PORTAL,
      portalOrgId: "portal-org-1",
      productTenantId: TENANT,
      workspaceId: TENANT,
      deploymentId: "deployment-1",
      userId: "operator-1",
      agentId,
      consentId,
      consentRevision: 1,
      pluginId,
      actionKey,
      capability: "connector.dispatch",
      connectionId: store.getConnection(TENANT, pluginId)!.id,
      accountId: "connector",
      resourceKind: `${pluginId}.connected-account`,
      resourceRef: "account:connector",
      capabilities: ["connector.dispatch"],
      requiredActions: ["create"],
    }).consent;
  const consents = {
    nc: consentFor("agent-1", "consent-nc-upload", NEXTCLOUD, NC_UPLOAD),
    ncForeign: consentFor("agent-2", "consent-nc-upload-b", NEXTCLOUD, NC_UPLOAD),
    ncNoFile: consentFor("agent-1", "consent-nc-propfind", NEXTCLOUD, NC_PROPFIND),
    postiz: consentFor("agent-1", "consent-postiz-upload", POSTIZ, POSTIZ_UPLOAD),
  };
  const upload = (
    bytes: Buffer,
    opts: { consentId?: string; name?: string; type?: string; key?: string; grant?: string; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method: "POST",
      url: `/api/marketplace/v1/agent/tool-files?consentId=${encodeURIComponent(opts.consentId ?? "consent-nc-upload")}&name=${encodeURIComponent(opts.name ?? "logo.png")}`,
      headers: {
        authorization: `Bearer ${opts.grant ?? GRANT_A}`,
        "content-type": opts.type ?? "image/png",
        "idempotency-key": opts.key ?? `upload.call-key-0001.${sha(bytes).slice(0, 16)}`,
        ...opts.headers,
      },
      payload: bytes,
    });
  const call = (body: Record<string, unknown>, key: string, grant = GRANT_A) =>
    app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/tools/call",
      headers: { authorization: `Bearer ${grant}`, "idempotency-key": key },
      payload: body,
    });
  const ncCall = (file: Record<string, unknown>, key: string, grant = GRANT_A, consentId = "consent-nc-upload") =>
    call({ consentId, toolkit: NEXTCLOUD, action: NC_UPLOAD, arguments: { path: { user: USER, path: "Talks/logo.png" }, body: file } }, key, grant);
  const postizCall = (file: Record<string, unknown>, key: string) =>
    call({ consentId: "consent-postiz-upload", toolkit: POSTIZ, action: POSTIZ_UPLOAD, arguments: { body: { file } } }, key);
  const refOf = (json: Record<string, unknown>) => ({
    fileRef: json.fileRef,
    sha256: json.sha256,
    bytes: json.bytes,
    contentType: json.contentType,
    filename: json.filename,
  });
  const filesDir = path.join(root, "data", TOOL_FILES_SUBDIR);
  const storedFiles = () => (existsSync(filesDir) ? readdirSync(filesDir).filter((name) => name.startsWith("tf_")) : []);
  const audit = () =>
    (store.listAudit({ workspaceSlug: TENANT, limit: 500 }) as Array<{ event_type: string; metadata: string }>).map((row) => ({
      type: row.event_type,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    }));
  return {
    app,
    store,
    rest,
    operator,
    consents,
    upload,
    call,
    ncCall,
    postizCall,
    refOf,
    filesDir,
    storedFiles,
    audit,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("tool-files.upload", () => {
  it("stores the file name byte for byte and refuses any name it would have to change", async () => {
    const f = await fixture();
    const png = PNG;
    for (const name of ["logo.png", "Speaker pack — Chiang Mai.png", "日本語.png"]) {
      const res = await f.upload(png, { name, key: `upload.name-ok-${Buffer.from(name).toString("hex").slice(0, 16)}.${sha(png).slice(0, 16)}` });
      expect(res.statusCode, name).toBe(201);
      expect(res.json().filename, name).toBe(name);
    }
    for (const name of ["", " logo.png", "logo.png ", "a/b.png", "a\\b.png", "lo\u0000go.png", "lo\u202ego.png", "lo\u200bgo.png", ".", "..", `${"a".repeat(252)}.png`]) {
      const res = await f.upload(png, { name, key: `upload.name-bad-${Buffer.from(name).toString("hex").slice(0, 16).padEnd(8, "0")}.${sha(png).slice(0, 16)}` });
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
      expect(res.json().error, JSON.stringify(name)).toBe("tool_file_name_invalid");
    }
  });

  it("stores an allowed file once and returns a reference without a URL", async () => {
    const f = await fixture();
    const response = await f.upload(PNG);
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json();
    expect(body).toEqual({
      ok: true,
      schema: 1,
      fileRef: expect.stringMatching(/^tf_[A-Za-z0-9_-]{32}$/u),
      sha256: sha(PNG),
      bytes: PNG.byteLength,
      contentType: "image/png",
      filename: "logo.png",
      expiresAt: expect.any(String),
    });
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(23 * HOUR);
    expect(response.body).not.toMatch(/https?:/u);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(f.storedFiles()).toEqual([body.fileRef]);
    // Audit / Activity: ids, sha256 and size only.
    const uploaded = f.audit().find((event) => event.type === "marketplace.tool_files.uploaded")!;
    expect(uploaded.metadata).toMatchObject({ fileRef: body.fileRef, sha256: sha(PNG), bytes: PNG.byteLength });
    expect(JSON.stringify(uploaded.metadata)).not.toContain("logo.png");
    expect(JSON.stringify(f.audit())).not.toContain(PNG.toString("base64"));
  });

  it("accepts the allowlisted types whose bytes match and refuses SVG, HTML, JS and magic-byte mismatches", async () => {
    const f = await fixture();
    const accepted: Array<[Buffer, string, string]> = [
      [PDF, "application/pdf", "deck.pdf"],
      [DOCX, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "notes.docx"],
      [ZIP, "application/zip", "pack.zip"],
      [Buffer.from("# Speaker notes\n"), "text/markdown", "notes.md"],
      [Buffer.from("a,b\n1,2\n"), "text/csv", "table.csv"],
    ];
    for (const [bytes, type, name] of accepted) {
      const response = await f.upload(bytes, { type, name, key: `upload.accepted.${name}` });
      expect(response.statusCode, `${type}: ${response.body}`).toBe(201);
    }
    const refused: Array<[Buffer, string, string, number, string]> = [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml", "x.svg", 415, "tool_file_type_invalid"],
      [Buffer.from("<html><script>alert(1)</script></html>"), "text/html", "x.html", 415, "tool_file_type_invalid"],
      [Buffer.from("alert(1)"), "application/javascript", "x.js", 415, "tool_file_type_invalid"],
      [Buffer.from("alert(1)"), "text/javascript", "x.js", 415, "tool_file_type_invalid"],
      [PDF, "image/png", "x.png", 422, "tool_file_type_mismatch"],
      [PNG, "image/png", "x.pdf", 422, "tool_file_type_mismatch"],
      [PNG, "application/pdf", "x.pdf", 422, "tool_file_type_mismatch"],
      [ZIP, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "x.pptx", 422, "tool_file_type_mismatch"],
      [Buffer.from([0x00, 0x01, 0x02]), "text/plain", "x.txt", 422, "tool_file_type_mismatch"],
      [Buffer.from("x"), "text/markdown", "notes.html", 422, "tool_file_type_mismatch"],
    ];
    for (const [bytes, type, name, status, error] of refused) {
      const response = await f.upload(bytes, { type, name, key: `upload.refused.${name}.${type.replace(/\W/gu, "")}` });
      expect(response.statusCode, `${type} ${name}: ${response.body}`).toBe(status);
      expect(response.json()).toEqual({ ok: false, error });
    }
    expect(f.storedFiles()).toHaveLength(accepted.length);
  });

  it("refuses files over the upload cap and empty files", async () => {
    const f = await fixture({ maxUploadBytes: 4096 });
    const big = Buffer.concat([PNG, Buffer.alloc(5000, 1)]);
    const tooBig = await f.upload(big);
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json()).toEqual({ ok: false, error: "tool_file_too_large", maxBytes: 4096 });
    const empty = await f.upload(Buffer.alloc(0), { key: "upload.empty-file-0001" });
    expect(empty.statusCode).toBe(400);
    expect(f.storedFiles()).toEqual([]);
  });

  it("keeps each agent within 20 live files", async () => {
    const f = await fixture();
    for (let index = 0; index < TOOL_FILE_QUOTA_FILES; index += 1) {
      const bytes = Buffer.concat([PNG, Buffer.from(String(index))]);
      const response = await f.upload(bytes, { key: `upload.quota-${index}-key` });
      expect(response.statusCode, response.body).toBe(201);
    }
    const over = await f.upload(Buffer.concat([PNG, Buffer.from("over")]), { key: "upload.quota-over-key" });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ error: "tool_file_quota_exceeded", limit: "files", maxFiles: 20, maxBytes: 200 * 1024 * 1024 });
    // Another agent has its own quota.
    const other = await f.upload(PNG, { consentId: "consent-nc-upload-b", grant: GRANT_B, key: "upload.other-agent-key" });
    expect(other.statusCode).toBe(201);
    // Expired files no longer count.
    f.advance(25 * HOUR);
    const after = await f.upload(Buffer.concat([PNG, Buffer.from("after")]), { key: "upload.quota-after-key" });
    expect(after.statusCode, after.body).toBe(201);
    // The sweep deleted every expired file (both agents'); only the new one holds bytes.
    expect(f.storedFiles()).toHaveLength(1);
  });

  it("answers one uniform 404 for a foreign, unknown, inactive or file-less consent", async () => {
    const f = await fixture();
    const foreign = await f.upload(PNG, { consentId: "consent-nc-upload-b", key: "upload.foreign-0001" });
    const unknown = await f.upload(PNG, { consentId: "consent-missing", key: "upload.unknown-0001" });
    const noFile = await f.upload(PNG, { consentId: "consent-nc-propfind", key: "upload.nofile-0001" });
    f.store.revokeMarketplaceAgentConsent(f.consents.postiz.id);
    const revoked = await f.upload(PNG, { consentId: "consent-postiz-upload", key: "upload.revoked-0001" });
    for (const response of [foreign, unknown, noFile, revoked]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ ok: false, error: "consent_not_found" });
    }
    expect(f.storedFiles()).toEqual([]);
  });

  it("needs the upload operation in the grant, an app grant at all, and an idempotency key", async () => {
    const f = await fixture();
    const notGranted = await f.upload(PNG, { grant: GRANT_CALL_ONLY });
    expect(notGranted.statusCode).toBe(403);
    const anonymous = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/tool-files?consentId=consent-nc-upload&name=logo.png",
      headers: { authorization: `Bearer ${SERVICE}`, "content-type": "image/png" },
      payload: PNG,
    });
    expect(anonymous.statusCode).toBe(403);
    expect(anonymous.json()).toEqual({ ok: false, error: "agent_grant_required" });
    const noKey = await f.upload(PNG, { key: "short" });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json()).toEqual({ ok: false, error: "idempotency_key_required" });
    const noName = await f.upload(PNG, { name: "" });
    expect(noName.statusCode).toBe(400);
    expect(f.storedFiles()).toEqual([]);
  });

  it("replays the same key with the same answer and no second file; another file under that key conflicts", async () => {
    const f = await fixture();
    const first = await f.upload(PNG, { key: "upload.tools-key-1.0123456789abcdef" });
    const again = await f.upload(PNG, { key: "upload.tools-key-1.0123456789abcdef" });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual({ ...first.json(), replayed: true });
    expect(f.storedFiles()).toHaveLength(1);
    const other = await f.upload(Buffer.concat([PNG, Buffer.from("x")]), { key: "upload.tools-key-1.0123456789abcdef" });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toEqual({ ok: false, error: "idempotency_conflict" });
    expect(f.storedFiles()).toHaveLength(1);
    expect(f.audit().filter((event) => event.type === "marketplace.tool_files.uploaded")).toHaveLength(1);
  });
});

describe("tools.call with a file reference (Nextcloud webdav-files-upload, not held)", () => {
  it("resolves the reference, sends the exact bytes with PUT, and consumes the file (single use)", async () => {
    const f = await fixture();
    const uploaded = (await f.upload(PNG)).json();
    const before = f.rest.requests.length;
    const response = await f.ncCall(f.refOf(uploaded), "call-key-0001");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, resultTrust: "untrusted-provider-data" });
    expect(f.rest.requests.length).toBe(before + 1);
    const sent = f.rest.requests.at(-1)!;
    expect(sent).toMatchObject({ method: "PUT", path: `/remote.php/dav/files/${USER}/Talks/logo.png` });
    expect(sent.raw.equals(PNG)).toBe(true);
    // The raw body goes with the operation's declared media type.
    expect(sent.headers["content-type"]).toBe("application/octet-stream");
    // Consumed: bytes deleted, the reference never resolves again, and an exact retry replays.
    expect(f.storedFiles()).toEqual([]);
    const reuse = await f.ncCall(f.refOf(uploaded), "call-key-0002");
    expect(reuse.statusCode).toBe(404);
    expect(reuse.json()).toEqual({ ok: false, error: "tool_file_not_found" });
    const replay = await f.ncCall(f.refOf(uploaded), "call-key-0001");
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true });
    expect(f.rest.requests.length).toBe(before + 1);
    // The usage ledger and audit keep the reference, never the bytes.
    const usage = f.store.listUsage({ workspaceSlug: TENANT }) as unknown[];
    expect(usage.length).toBeGreaterThan(0);
    expect(JSON.stringify(usage)).not.toContain(PNG.toString("base64"));
    expect(JSON.stringify(f.audit())).not.toContain(PNG.toString("base64"));
    const consumed = f.audit().find((event) => event.type === "marketplace.tool_files.consumed")!;
    expect(consumed.metadata).toMatchObject({ fileRef: uploaded.fileRef, sha256: sha(PNG), bytes: PNG.byteLength, via: "tools.call" });
  });

  it("answers 409 tool_file_mismatch for any declared value that differs from the stored file", async () => {
    const f = await fixture();
    const uploaded = (await f.upload(PNG)).json();
    const ref = f.refOf(uploaded);
    const before = f.rest.requests.length;
    const variants = [
      { ...ref, sha256: "0".repeat(64) },
      { ...ref, bytes: PNG.byteLength + 1 },
      { ...ref, contentType: "application/pdf" },
      { ...ref, filename: "other.png" },
    ];
    for (const [index, variant] of variants.entries()) {
      const response = await f.ncCall(variant, `mismatch-key-000${index}`);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ ok: false, error: "tool_file_mismatch", field: "body" });
    }
    expect(f.rest.requests.length).toBe(before);
    const mismatches = f.audit().filter((event) => event.type === "marketplace.tool_files.mismatch");
    expect(mismatches).toHaveLength(4);
    expect(mismatches[0]!.metadata).toMatchObject({ sha256: sha(PNG), bytes: PNG.byteLength });
    // Still unused: the correct reference works.
    const ok = await f.ncCall(ref, "mismatch-key-ok01");
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("answers the same 404 for a foreign, unknown, expired or consumed reference", async () => {
    const f = await fixture();
    const own = (await f.upload(PNG)).json();
    const foreign = (await f.upload(PNG, { consentId: "consent-nc-upload-b", grant: GRANT_B, key: "upload.agent-b-0001" })).json();
    const other = (await f.upload(PDF, { type: "application/pdf", name: "deck.pdf", key: "upload.pdf-0001" })).json();
    const before = f.rest.requests.length;
    const foreignUse = await f.ncCall(f.refOf(foreign), "foreign-key-0001");
    const unknownUse = await f.ncCall({ ...f.refOf(own), fileRef: `tf_${"z".repeat(32)}` }, "unknown-key-0001");
    // The other agent cannot use agent-1's file with its own consent either.
    const crossed = await f.ncCall(f.refOf(own), "crossed-key-0001", GRANT_B, "consent-nc-upload-b");
    f.advance(24 * HOUR + 1000);
    const expiredUse = await f.ncCall(f.refOf(other), "expired-key-0001");
    for (const response of [foreignUse, unknownUse, crossed, expiredUse]) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toEqual({ ok: false, error: "tool_file_not_found" });
    }
    expect(f.rest.requests.length).toBe(before);
    // TTL: the sweep deleted the expired bytes and recorded it.
    expect(f.storedFiles()).not.toContain(other.fileRef);
    expect(f.audit().some((event) => event.type === "marketplace.tool_files.expired" && event.metadata.fileRef === other.fileRef)).toBe(true);
  });

  it("refuses a malformed reference or a URL without any outbound request (no SSRF), and keeps the 12 KB cap", async () => {
    const f = await fixture();
    const uploaded = (await f.upload(PNG)).json();
    const ref = f.refOf(uploaded);
    const before = f.rest.requests.length;
    for (const [index, bad] of [
      { ...ref, fileRef: "https://evil.example/file.png" },
      { ...ref, fileRef: "http://127.0.0.1:1/x" },
      { ...ref, url: "https://evil.example/file.png" },
      { fileRef: ref.fileRef },
      { ...ref, bytes: "24" },
    ].entries()) {
      const response = await f.ncCall(bad, `bad-ref-key-000${index}`);
      expect(response.statusCode, JSON.stringify(bad)).toBe(400);
      expect(response.json()).toEqual({ ok: false, error: "tool_file_ref_invalid", field: "body" });
    }
    const big = await f.call(
      { consentId: "consent-nc-upload", toolkit: NEXTCLOUD, action: NC_UPLOAD, arguments: { path: { user: USER, path: "a.txt" }, body: { ...ref, pad: "x".repeat(13_000) } } },
      "big-ref-key-0001",
    );
    expect(big.statusCode).toBe(413);
    expect(f.rest.requests.length).toBe(before);
  });

  it("re-hashes the stored bytes at execution and refuses a file changed on disk", async () => {
    const f = await fixture();
    const uploaded = (await f.upload(PNG)).json();
    writeFileSync(path.join(f.filesDir, uploaded.fileRef), Buffer.concat([PNG, Buffer.from("tampered")]));
    const before = f.rest.requests.length;
    const response = await f.ncCall(f.refOf(uploaded), "rehash-key-0001");
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: "tool_file_mismatch" });
    expect(f.rest.requests.length).toBe(before);
    expect(f.audit().some((event) => event.type === "marketplace.tool_files.mismatch" && event.metadata.reason === "stored")).toBe(true);
  });
});

describe("tools.call with a file reference (Postiz upload-simple, held for the owner)", () => {
  it("holds the reference (not bytes), pins the file past its TTL, shows it to the owner and uploads it on approval", async () => {
    const f = await fixture();
    const uploaded = (await f.upload(PNG, { consentId: "consent-postiz-upload", key: "upload.postiz-0001" })).json();
    const ref = f.refOf(uploaded);
    const before = f.rest.requests.length;
    const held = await f.postizCall(ref, "postiz-key-0001");
    expect(held.statusCode, held.body).toBe(202);
    expect(held.json()).toMatchObject({ ok: false, status: "approval_pending", approvalId: expect.any(String) });
    expect(f.rest.requests.length).toBe(before);
    const approvalId = held.json().approvalId as string;
    const approval = f.store.getCompanyBoxApproval(approvalId)!;
    // Held arguments are the reference; the digest covers {fileRef, sha256, bytes, contentType, filename}.
    expect(approval.arguments).toEqual({ body: { file: ref } });
    expect(approval.fingerprint).toBe(sha256Text(stableJson({ actionKey: POSTIZ_UPLOAD, args: { body: { file: ref } } })));
    expect(JSON.stringify(approval)).not.toContain(PNG.toString("base64"));
    // A retry with the same key reports the held call, not a 404.
    const repeat = await f.postizCall(ref, "postiz-key-0001");
    expect(repeat.statusCode).toBe(202);
    // Pinned until the decision: the 24 h TTL no longer applies (7 d approval expiry does).
    f.advance(30 * HOUR);
    const list = await f.app.inject({ method: "GET", url: "/api/marketplace/company-box/approvals", headers: f.operator });
    expect(list.statusCode, list.body).toBe(200);
    const view = (list.json().approvals as Array<Record<string, unknown>>).find((entry) => entry.id === approvalId)!;
    expect(view.files).toEqual([
      { field: "body.file", fileRef: uploaded.fileRef, filename: "logo.png", contentType: "image/png", bytes: PNG.byteLength, sha256: sha(PNG), state: "pinned", previewable: true },
    ]);
    expect(view.digest).toBe(approval.fingerprint);
    expect(f.storedFiles()).toEqual([uploaded.fileRef]);
    // Owner preview (inline image) and download, re-hashed, sandboxed.
    const fileUrl = `/api/marketplace/company-box/approvals/${approvalId}/files/${uploaded.fileRef}`;
    const preview = await f.app.inject({ method: "GET", url: fileUrl, headers: f.operator });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload.equals(PNG)).toBe(true);
    expect(preview.headers["content-type"]).toBe("image/png");
    expect(preview.headers["x-content-type-options"]).toBe("nosniff");
    expect(preview.headers["cache-control"]).toBe("no-store");
    expect(preview.headers["content-security-policy"]).toContain("sandbox");
    expect(preview.headers["content-disposition"]).toMatch(/^inline; filename="logo.png"/u);
    const download = await f.app.inject({ method: "GET", url: `${fileUrl}?download=1`, headers: f.operator });
    expect(download.headers["content-disposition"]).toMatch(/^attachment;/u);
    // Never for an agent, never without the owner session.
    const asAgent = await f.app.inject({ method: "GET", url: fileUrl, headers: { authorization: `Bearer ${GRANT_A}` } });
    expect(asAgent.statusCode).toBe(403);
    const anonymous = await f.app.inject({ method: "GET", url: fileUrl });
    expect(anonymous.statusCode).toBeGreaterThanOrEqual(401);
    expect(anonymous.statusCode).toBeLessThan(404);

    const approve = await f.app.inject({ method: "POST", url: `/api/marketplace/company-box/approvals/${approvalId}/approve`, headers: f.operator });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(approve.json()).toMatchObject({ ok: true, approval: { state: "succeeded" } });
    const sent = f.rest.requests.at(-1)!;
    expect(sent).toMatchObject({ method: "POST", path: "/api/public/v1/upload" });
    expect(String(sent.headers["content-type"])).toMatch(/^multipart\/form-data/u);
    expect(sent.raw.includes(PNG)).toBe(true);
    expect(sent.raw.toString("latin1")).toContain('filename="logo.png"');
    // Consumed on execution; the bytes are gone and the preview with them.
    expect(f.storedFiles()).toEqual([]);
    expect(f.store.toolFiles.get(uploaded.fileRef)).toMatchObject({ state: "consumed", approvalId });
    const gone = await f.app.inject({ method: "GET", url: fileUrl, headers: f.operator });
    expect(gone.statusCode).toBe(404);
    const consumed = f.audit().find((event) => event.type === "marketplace.tool_files.consumed")!;
    expect(consumed.metadata).toMatchObject({ via: "approval", approvalId, sha256: sha(PNG), bytes: PNG.byteLength });
  });

  it("deletes the pinned file when the owner denies the call", async () => {
    const f = await fixture();
    const uploaded = (await f.upload(PNG, { consentId: "consent-postiz-upload", key: "upload.postiz-deny" })).json();
    const held = await f.postizCall(f.refOf(uploaded), "postiz-deny-0001");
    expect(held.statusCode).toBe(202);
    const deny = await f.app.inject({ method: "POST", url: `/api/marketplace/company-box/approvals/${held.json().approvalId}/deny`, headers: f.operator });
    expect(deny.statusCode, deny.body).toBe(200);
    expect(f.storedFiles()).toEqual([]);
    expect(f.store.toolFiles.get(uploaded.fileRef)).toMatchObject({ state: "released" });
    expect(f.audit().some((event) => event.type === "marketplace.tool_files.released")).toBe(true);
  });

  it("deletes the pinned file when the approval expires (7 d)", async () => {
    const f = await fixture();
    const uploaded = (await f.upload(PNG, { consentId: "consent-postiz-upload", key: "upload.postiz-exp" })).json();
    const held = await f.postizCall(f.refOf(uploaded), "postiz-exp-0001");
    expect(held.statusCode).toBe(202);
    f.advance(6 * 24 * HOUR);
    await f.app.inject({ method: "GET", url: "/api/marketplace/company-box/approvals", headers: f.operator });
    expect(f.storedFiles()).toEqual([uploaded.fileRef]);
    f.advance(24 * HOUR + 60_000);
    await f.app.inject({ method: "GET", url: "/api/marketplace/company-box/approvals", headers: f.operator });
    expect(f.storedFiles()).toEqual([]);
    expect(f.store.toolFiles.get(uploaded.fileRef)).toMatchObject({ state: "expired" });
  });

  it("re-hashes at approval time and fails the call when the stored bytes changed", async () => {
    const f = await fixture();
    const uploaded = (await f.upload(PNG, { consentId: "consent-postiz-upload", key: "upload.postiz-tamper" })).json();
    const held = await f.postizCall(f.refOf(uploaded), "postiz-tamper-0001");
    writeFileSync(path.join(f.filesDir, uploaded.fileRef), Buffer.concat([PNG, Buffer.from("tampered")]));
    const before = f.rest.requests.length;
    const approve = await f.app.inject({ method: "POST", url: `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, headers: f.operator });
    expect(approve.json()).toMatchObject({ ok: false, approval: { state: "failed", error: "tool_file_mismatch" } });
    expect(f.rest.requests.length).toBe(before);
    expect(f.storedFiles()).toEqual([]);
  });

  it("holds a file far larger than the 32 KB held-argument cap", async () => {
    const f = await fixture();
    const large = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024, 7)]);
    const uploaded = (await f.upload(large, { consentId: "consent-postiz-upload", key: "upload.postiz-large" })).json();
    const held = await f.postizCall(f.refOf(uploaded), "postiz-large-0001");
    expect(held.statusCode, held.body).toBe(202);
    // Inline, the same file is refused by the held-argument cap.
    const inline = await f.postizCall({ base64: large.toString("base64"), filename: "big.png", contentType: "image/png" }, "postiz-inline-01");
    expect(inline.statusCode).toBe(413);
  });
});

describe("tool file helpers", () => {
  it("finds the x-file-upload positions of the shipped operations", () => {
    const raw = { type: "object", properties: { body: { type: "object", "x-file-upload": true } } };
    expect(fileArgumentPaths(raw)).toEqual([["body"]]);
    const multipart = {
      type: "object",
      properties: { body: { type: "object", properties: { file: { "x-file-upload": true }, files: { type: "array", items: { "x-file-upload": true } }, name: { type: "string" } } } },
    };
    expect(fileArgumentPaths(multipart)).toEqual([["body", "file"], ["body", "files", "*"]]);
    const ref = { fileRef: `tf_${"a".repeat(32)}`, sha256: "a".repeat(64), bytes: 3, contentType: "image/png", filename: "a.png" };
    const found = findToolFileRefs({ body: { files: [{ base64: "aGk=" }, ref], file: ref, name: { fileRef: "ignored" } } }, fileArgumentPaths(multipart));
    expect(found.map((entry) => entry.field)).toEqual(["body.file", "body.files.1"]);
    expect(() => findToolFileRefs({ body: { fileRef: "https://evil.example/x" } }, [["body"]])).toThrow(ToolFileError);
  });

  it("checks the allowlist, the extension and the magic bytes", () => {
    expect(checkToolFileType({ bytes: PNG, contentType: "image/png", filename: "a.PNG" })).toEqual({ ok: true });
    expect(checkToolFileType({ bytes: PNG, contentType: "image/svg+xml", filename: "a.svg" })).toMatchObject({ ok: false, status: 415 });
    expect(checkToolFileType({ bytes: Buffer.from("GIF89a..."), contentType: "image/gif", filename: "a.gif" })).toEqual({ ok: true });
    expect(checkToolFileType({ bytes: Buffer.from("RIFF....WEBPVP8 "), contentType: "image/webp", filename: "a.webp" })).toEqual({ ok: true });
    expect(checkToolFileType({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), contentType: "image/jpeg", filename: "a.jpg" })).toEqual({ ok: true });
    expect(checkToolFileType({ bytes: DOCX, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "a.xlsx" })).toEqual({ ok: true });
  });

  it("keeps the byte quota inside one transaction", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "marketplace-tool-files-store-"));
    const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"), { handoffEncryptionKey: "a".repeat(64) });
    try {
      const binding = { workspaceSlug: "ws", deploymentId: "d", agentId: "agent", consentId: "c" };
      const insert = (id: string, bytes: number, key: string) =>
        store.toolFiles.insertWithinQuota({
          id,
          binding,
          pluginId: "p",
          actionKey: "a",
          sha256: "a".repeat(64),
          bytes,
          contentType: "image/png",
          filename: "a.png",
          idempotencyKey: key,
          fingerprint: key,
          response: () => ({ status: 201, body: {} }),
          now: new Date(),
          ttlMs: HOUR,
          maxFiles: 20,
          maxBytes: 100,
          write: () => undefined,
        });
      expect(insert(`tf_${"a".repeat(32)}`, 60, "key-a")).toMatchObject({ ok: true, created: true });
      expect(insert(`tf_${"b".repeat(32)}`, 41, "key-b")).toEqual({ ok: false, error: "tool_file_quota_exceeded", limit: "bytes" });
      expect(insert(`tf_${"c".repeat(32)}`, 40, "key-c")).toMatchObject({ ok: true, created: true });
      // Same key: the stored row, no second file.
      expect(insert(`tf_${"d".repeat(32)}`, 1, "key-a")).toMatchObject({ ok: true, created: false, record: { id: `tf_${"a".repeat(32)}` } });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function sha256Text(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
