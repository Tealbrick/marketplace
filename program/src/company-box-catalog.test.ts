/**
 * The shipped Company Box catalog (`program/catalog/company-box`): every entry
 * loads through the real catalog loader and every operation in its pinned spec
 * (after its overlay) is exposed or excluded with a reason. The agent-path
 * suites (every exposed operation reached through the agent surface against a
 * fake REST server, outward operations held) live in
 * `company-box-agent-<id>.test.ts`, one file per entry so the large ones run in
 * parallel workers.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPANY_BOX_CATALOG_DIR,
  loadCompanyBoxCatalog,
  type CompiledOpenApiEntry,
} from "./company-box.js";
import { companyBoxCoverageReport } from "./company-box-coverage.js";
import { EXPECTED, METHODS, rawSpecOperationCount, specOperationCount, SPEC_METHODS } from "./testing/company-box-catalog-harness.js";

describe("shipped Company Box catalog", () => {
  const catalog = loadCompanyBoxCatalog(DEFAULT_COMPANY_BOX_CATALOG_DIR);

  it("loads exactly the shipped entries without errors", () => {
    expect(catalog.loadErrors).toEqual([]);
    expect(catalog.entries.map((entry) => entry.entry.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const entry of catalog.entries) expect(entry.errors, entry.entry.id).toEqual([]);
  });

  it("accounts for every operation of the pinned spec as exposed or excluded with a reason", () => {
    const report = companyBoxCoverageReport(DEFAULT_COMPANY_BOX_CATALOG_DIR);
    expect(report.ok).toBe(true);
    for (const [id, expected] of Object.entries(EXPECTED)) {
      const compiled = catalog.get(id) as CompiledOpenApiEntry;
      const entry = report.entries.find((candidate) => candidate.id === id)!;
      const specTotal = specOperationCount(id); // after the entry's overlay
      expect(specTotal, `${id} spec`).toBe(expected.total);
      expect(entry, id).toMatchObject({
        total: expected.total,
        exposed: expected.exposed,
        excluded: expected.excluded,
        failed: 0,
        outward: expected.outward,
        exposure: expected.exposure,
        ok: true,
      });
      expect(entry.exposed + entry.excluded, `${id} exposed + excluded`).toBe(specTotal);
      // Formbricks v1 declares the API key as a header parameter; the engine drops it and warns.
      expect(entry.warnings, `${id} warnings`).toEqual(
        id === "formbricks" ? ["26 declared credential parameter(s) dropped; Marketplace sets the credential itself."] : [],
      );
      expect(compiled.entry.auth).toMatchObject(expected.auth);
      expect(compiled.healthOperation, `${id} health`).toMatchObject({ method: "get" });
      expect(compiled.entry.healthOperation).toBe(expected.health);
      expect(compiled.operations.filter((operation) => operation.outward)).toHaveLength(expected.outward);
      for (const exclusion of compiled.entry.excluded) {
        expect(exclusion.reason?.trim().length ?? 0, `${id} ${exclusion.operation}`).toBeGreaterThan(20);
      }
    }
  });

  it("keeps outward operations on write methods and DELETE operations destructive", () => {
    for (const id of Object.keys(EXPECTED)) {
      const compiled = catalog.get(id) as CompiledOpenApiEntry;
      for (const operation of compiled.operations) {
        if (operation.outward) expect(operation.write, `${id} ${operation.ref}`).toBe(true);
        if (operation.method === "delete") {
          expect(operation).toMatchObject({ destructive: true, capability: "connector.admin" });
        }
        if (operation.method === "get") expect(operation.capability).toBe("connector.observe");
      }
    }
  });

  it("marks only read-only POST operations as reads, never outward or destructive", () => {
    for (const [id, expected] of Object.entries(EXPECTED)) {
      const compiled = catalog.get(id) as CompiledOpenApiEntry;
      // PROPFIND and REPORT are reads by method (WebDAV); only POST reads are declared through `reads`.
      const reads = compiled.operations.filter(
        (operation) => !["get", "propfind", "report"].includes(operation.method) && operation.capability === "connector.observe",
      );
      expect(reads.map((operation) => `${operation.method.toUpperCase()} ${operation.path}`).sort(), id).toEqual([...expected.reads].sort());
      for (const operation of reads) {
        expect(operation, `${id} ${operation.ref}`).toMatchObject({ write: false, outward: false, destructive: false });
        expect(operation.method, `${id} ${operation.ref}`).toBe("post");
      }
    }
  });

  it("keeps upstream specs pristine and applies overlays only where needed", () => {
    const withOverlay = catalog.entries.filter((entry) => entry.kind === "openapi" && entry.entry.openapi?.overlay).map((entry) => entry.entry.id);
    expect(withOverlay.sort()).toEqual(["authentik", "changedetection", "chatwoot", "formbricks", "postiz"]);
    const postizSpec = readFileSync(path.join(DEFAULT_COMPANY_BOX_CATALOG_DIR, "postiz", "openapi.json"), "utf8");
    expect(postizSpec).not.toContain("x-company-box-supplement");
    const postiz = catalog.get("postiz") as CompiledOpenApiEntry;
    expect(postiz.byKey.get("company-box-postiz.public-integrations-controller-create-post")?.argumentGroups).toContain("body");
    expect(postiz.byKey.get("company-box-postiz.public-integrations-controller-upload-simple")?.argumentGroups).toContain("body");
    const listmonk = catalog.get("listmonk") as CompiledOpenApiEntry;
    expect(listmonk.coverage.find((item) => item.ref === "previewTemplateById")).toMatchObject({ status: "excluded", auto: true });
    expect(listmonk.entry.excluded.map((exclusion) => exclusion.operation).sort()).toEqual(["logout", "streamEvents"]);
  });

  it("excludes only Easy!Appointments admin and settings operations", () => {
    const compiled = catalog.get("easyappointments") as CompiledOpenApiEntry;
    expect(compiled.entry.excluded.map((exclusion) => exclusion.operation).sort()).toEqual(
      [
        "DELETE /admins/{adminId}",
        "GET /admins",
        "GET /admins/{adminId}",
        "GET /settings",
        "GET /settings/{settingName}",
        "POST /admins",
        "PUT /admins/{adminId}",
        "PUT /settings/{settingName}",
      ].sort(),
    );
    expect(compiled.operations.filter((operation) => operation.outward).map((operation) => operation.ref).sort()).toEqual([
      "DELETE /appointments/{appointmentId}",
      "POST /appointments",
      "POST /webhooks",
      "PUT /appointments/{appointmentId}",
      "PUT /webhooks/{webhookId}",
    ]);
  });

  it("vendors only the public Postiz API", () => {
    const compiled = catalog.get("postiz") as CompiledOpenApiEntry;
    expect(compiled.apiBasePath).toBe("/api");
    expect(compiled.operations.every((operation) => operation.path.startsWith("/public/v1/"))).toBe(true);
    expect(compiled.entry.excluded).toEqual([]);
  });

  it("exposes every operation of the current Formbricks generations and excludes the legacy root per operation", () => {
    const compiled = catalog.get("formbricks") as CompiledOpenApiEntry;
    const generation = (tags: string[]) => tags.find((tag) => tag.startsWith("api-") || tag === "legacy-root");
    const spec = JSON.parse(readFileSync(path.join(DEFAULT_COMPANY_BOX_CATALOG_DIR, "formbricks", "openapi.json"), "utf8")) as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    const perGeneration: Record<string, number> = {};
    for (const item of Object.values(spec.paths)) {
      for (const method of METHODS) {
        const tag = item[method] && generation(item[method]!.tags ?? []);
        if (tag) perGeneration[tag] = (perGeneration[tag] ?? 0) + 1;
      }
    }
    expect(perGeneration).toEqual({ "api-v1": 32, "api-v2": 40, "api-v3": 36, "legacy-root": 5 });
    const exposedByGeneration: Record<string, number> = {};
    for (const operation of compiled.operations) {
      const tag = generation(operation.tags)!;
      exposedByGeneration[tag] = (exposedByGeneration[tag] ?? 0) + 1;
    }
    expect(exposedByGeneration).toEqual({ "api-v1": 32, "api-v2": 40, "api-v3": 36 });
    const excluded = compiled.entry.excluded;
    expect(excluded).toHaveLength(5);
    expect(excluded.every((exclusion) => exclusion.operation.includes(" /api/responses"))).toBe(true);
    expect(new Set(excluded.map((exclusion) => exclusion.reason)).size).toBe(5);
    for (const exclusion of excluded) {
      const successor = /superseded by (\S+ \S+),/u.exec(exclusion.reason!)?.[1];
      expect(successor, exclusion.operation).toBeTruthy();
      expect(
        compiled.operations.some((operation) => `${operation.method.toUpperCase()} ${operation.path}` === successor),
        `${exclusion.operation} -> ${successor}`,
      ).toBe(true);
    }
  });

  it("merges every enabled Nextcloud OCS app spec, namespaced and tagged by app, with a documented exclusion per operation", () => {
    const compiled = catalog.get("nextcloud") as CompiledOpenApiEntry;
    expect(compiled.entry.app.version).toBe("31.0.14");
    const spec = JSON.parse(readFileSync(path.join(DEFAULT_COMPANY_BOX_CATALOG_DIR, "nextcloud", "openapi.json"), "utf8")) as {
      info: Record<string, unknown>;
      paths: Record<string, Record<string, { "x-nextcloud-app"?: string; "x-source"?: string; tags?: string[] }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.info["x-source"]).toBe("merged-upstream");
    const perApp: Record<string, number> = {};
    for (const item of Object.values(spec.paths)) {
      for (const method of SPEC_METHODS) {
        const operation = item[method];
        if (!operation) continue;
        const app = operation["x-nextcloud-app"]!;
        perApp[app] = (perApp[app] ?? 0) + 1;
        expect(operation.tags?.[0], `${method} ${app}`).toBe(app);
      }
    }
    expect(perApp).toEqual({
      activity: 3,
      cloud_federation_api: 2,
      core: 77,
      dashboard: 7,
      dav: 6,
      federatedfilesharing: 9,
      federation: 7,
      files: 16,
      files_external: 1,
      files_reminders: 3,
      files_sharing: 23,
      files_trashbin: 1,
      files_versions: 1,
      notifications: 12,
      oauth2: 2,
      password_policy: 2,
      provisioning_api: 43,
      recommendations: 2,
      serverinfo: 3,
      settings: 3,
      theming: 11,
      updatenotification: 2,
      user_oidc: 9,
      user_status: 10,
      weather_status: 7,
      webdav: 36,
      webhook_listeners: 6,
    });
    expect(spec.info["x-hand-authored-apps"]).toEqual(["activity", "serverinfo", "webdav"]);
    // Disabled apps (user_ldap) are not merged; component schemas are namespaced per app.
    expect(Object.keys(perApp)).not.toContain("user_ldap");
    expect(Object.keys(spec.components.schemas).every((name) => /^[a-z_0-9]+\./u.test(name))).toBe(true);
    // Every OCS operation declares the OCS-APIRequest header with default true, which the engine sends on its own.
    for (const operation of compiled.operations) {
      const header = operation.operation.parameters.find((parameter) => parameter.in === "header" && parameter.name === "OCS-APIRequest");
      if (operation.path.startsWith("/ocs/")) expect(header, operation.ref).toMatchObject({ required: true, schema: { type: "boolean", default: true } });
    }
    // Credential, login, app-enable and server-config operations stay out, each with its own reason.
    expect(compiled.entry.excluded.map((exclusion) => exclusion.operation).sort()).toEqual(
      [
        "app_config-set-value",
        "app_password-confirm-user-password",
        "app_password-delete-app-password",
        "app_password-get-app-password",
        "app_password-rotate-app-password",
        "apps-disable",
        "apps-enable",
        "client_flow_login_v2-init",
        "client_flow_login_v2-poll",
        "declarative_settings-set-value",
        "login-confirm-password",
        "login_redirector-authorize",
        "oauth_api-get-token",
        "settings-add-server",
        "settings-create-provider",
        "settings-delete-provider",
        "settings-remove-server",
        "settings-seti-d4me",
        "settings-set-admin-config",
        "settings-update-provider",
      ].sort(),
    );
    expect(compiled.coverage.filter((item) => item.status === "excluded" && item.auto)).toEqual([]);
    const outward = new Set(compiled.operations.filter((operation) => operation.outward).map((operation) => operation.operationId));
    for (const id of [
      "shareapi-create-share",
      "shareapi-update-share",
      "shareapi-send-share-email",
      "direct-get-url",
      "api-generate-notification-v3",
      "users-add-user",
      "users-resend-welcome-message",
      "webhooks-create",
      "remote-accept-share",
      "webdav-comments-create",
    ]) {
      expect(outward.has(id), id).toBe(true);
    }
    const byId = (id: string) => compiled.operations.find((operation) => operation.operationId === id);
    expect(byId("users-delete-user")).toMatchObject({ destructive: true, capability: "connector.admin" });
    expect(byId("users-wipe-user-devices")).toMatchObject({ destructive: true, outward: true });
    expect(byId("webdav-versions-restore")).toMatchObject({ destructive: true, capability: "connector.admin" });
    expect(byId("webdav-trashbin-empty")).toMatchObject({ destructive: true, capability: "connector.admin" });
    expect(byId("webdav-files-propfind")).toMatchObject({ method: "propfind", capability: "connector.observe", write: false, outward: false });
    // MOVE is always destructive (it can replace the target and removes the source); COPY has Overwrite fixed to F.
    expect(byId("webdav-files-move")).toMatchObject({ method: "move", capability: "connector.admin", destructive: true, write: true });
    expect(byId("webdav-files-copy")).toMatchObject({ method: "copy", capability: "connector.dispatch", destructive: false, write: true });
    expect(byId("webdav-trashbin-restore")).toMatchObject({ method: "move", destructive: true });
    expect(byId("webdav-uploads-finish")).toMatchObject({ method: "move", destructive: true });
    // Hand-authored operations are marked as such; upstream ones are not.
    const handAuthored: Record<string, number> = {};
    for (const item of Object.values(spec.paths)) {
      for (const method of SPEC_METHODS) {
        const operation = item[method];
        if (operation?.["x-source"] === "hand-authored") handAuthored[operation["x-nextcloud-app"]!] = (handAuthored[operation["x-nextcloud-app"]!] ?? 0) + 1;
      }
    }
    expect(handAuthored).toEqual({ activity: 3, serverinfo: 3, webdav: 36 });
    expect(byId("shareapi-get-shares")).toMatchObject({ capability: "connector.observe", outward: false });
    // The three query schemas that carry `nullable` without a type compile through the engine's own rewrite (no overlay).
    expect(byId("unified_search-search")?.operation.parameters.some((parameter) => parameter.name === "cursor")).toBe(true);
  });

  const dir = (id: string, file: string) => path.join(DEFAULT_COMPANY_BOX_CATALOG_DIR, id, file);
  const json = (id: string, file: string) => JSON.parse(readFileSync(dir(id, file), "utf8")) as Record<string, any>;
  const refs = (compiled: CompiledOpenApiEntry, pick: (operation: CompiledOpenApiEntry["operations"][number]) => boolean) =>
    compiled.operations.filter(pick).map((operation) => operation.operationId ?? operation.ref).sort();

  it("serves Documenso from the v2 OpenAPI with the raw token and holds everything that signs, sends or exposes", () => {
    const compiled = catalog.get("documenso") as CompiledOpenApiEntry;
    expect(compiled).toMatchObject({ apiBasePath: "/api/v2", exposure: "discovery" });
    expect(compiled.spec).toMatchObject({ format: "openapi-3", specVersion: "3.0.3" });
    expect(compiled.entry.auth).toEqual({ type: "header", name: "Authorization", label: "API token" });
    expect(compiled.entry.excluded).toEqual([]);
    expect(refs(compiled, (operation) => operation.outward)).toEqual(
      [
        "document-distribute",
        "document-redistribute",
        "embeddingPresign-createEmbeddingPresignToken",
        "envelope-cancel",
        "envelope-distribute",
        "envelope-recipient-rejectOnBehalfOf",
        "envelope-redistribute",
        "envelope-use",
        "template-createDocumentFromTemplate",
        "template-createTemplateDirectLink",
        "template-toggleTemplateDirectLink",
      ].sort(),
    );
    // Every delete is a POST .../delete in Documenso, so the pattern makes each one destructive (admin).
    const deletes = compiled.operations.filter((operation) => operation.path.endsWith("/delete"));
    expect(deletes.length).toBeGreaterThanOrEqual(10);
    for (const operation of deletes) expect(operation).toMatchObject({ method: "post", destructive: true, capability: "connector.admin" });
    expect(compiled.byKey.get("company-box-documenso.envelope-cancel")).toMatchObject({ destructive: true, outward: true });
    // Nullable oneOf/anyOf without a type (OpenAPI 3.0) compiles through the engine's rewrite.
    expect(compiled.operations).toHaveLength(89);
  });

  it("keeps changedetection GETs side-effect free by dropping the recheck, pause and mute query switches", () => {
    const compiled = catalog.get("changedetection") as CompiledOpenApiEntry;
    expect(compiled.apiBasePath).toBe("/api/v1");
    expect(compiled.entry.auth).toMatchObject({ type: "header", name: "x-api-key" });
    const raw = json("changedetection", "openapi.json");
    const names = (spec: Record<string, any>, route: string) => (spec.paths[route].get.parameters as Array<{ name: string }>).map((parameter) => parameter.name);
    expect(names(raw, "/watch")).toContain("recheck_all");
    expect(names(raw, "/watch/{uuid}")).toEqual(expect.arrayContaining(["recheck", "paused", "muted"]));
    for (const operation of compiled.operations.filter((candidate) => candidate.method === "get")) {
      const query = (operation.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>).query?.properties ?? {};
      for (const switchName of ["recheck", "recheck_all", "paused", "muted"]) {
        expect(query, `${operation.ref} ${switchName}`).not.toHaveProperty(switchName);
      }
    }
    expect(refs(compiled, (operation) => operation.outward)).toEqual(
      ["addNotifications", "createTag", "createWatch", "importWatches", "replaceNotifications", "updateTag", "updateWatch"].sort(),
    );
    expect(compiled.operations.every((operation) => operation.method === "get" || operation.write)).toBe(true);
  });

  it("adds the Chatwoot routes the upstream swagger lacks as x-source: code, verified against the controllers", () => {
    const compiled = catalog.get("chatwoot") as CompiledOpenApiEntry;
    const upstream = json("chatwoot", "openapi.json");
    const overlay = json("chatwoot", "overlay.json");
    const added: Array<[string, string, Record<string, any>]> = [];
    for (const [route, item] of Object.entries(overlay.paths as Record<string, Record<string, any>>)) {
      for (const method of METHODS) if (item[method]) added.push([method, route, item[method]]);
    }
    expect(rawSpecOperationCount("chatwoot")).toBe(154);
    expect(added).toHaveLength(296);
    expect(specOperationCount("chatwoot")).toBe(450);
    const upstreamKeys = new Set(
      Object.entries(upstream.paths as Record<string, Record<string, unknown>>).flatMap(([route, item]) => METHODS.filter((method) => item[method]).map((method) => `${method} ${route}`)),
    );
    for (const [method, route, operation] of added) {
      expect(operation["x-source"], `${method} ${route}`).toBe("code");
      expect(operation["x-code-route"], `${method} ${route}`).toMatch(/^[A-Z]+ \/.+ -> .+#\w+$/u);
      expect(upstreamKeys.has(`${method} ${route}`), `${method} ${route} is already in the swagger`).toBe(false);
    }
    expect(new Set(added.map(([, , operation]) => operation.operationId)).size).toBe(296);
    expect(compiled.byKey.get("company-box-chatwoot.captain-assistants-playground")).toBeTruthy();
    expect(compiled.entry.excluded.map((exclusion) => exclusion.operation).sort()).toEqual(["get-sso-url-of-a-user", "getConversationMessages"]);
    // Replies, new conversations and public client messages are held; internal notes are not distinguishable, so all message creates are.
    const outward = new Set(compiled.operations.filter((operation) => operation.outward).map((operation) => `${operation.method.toUpperCase()} ${operation.path}`));
    for (const held of [
      "POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/messages",
      "POST /api/v1/accounts/{account_id}/conversations",
      "POST /public/api/v1/inboxes/{inbox_identifier}/contacts/{contact_identifier}/conversations/{conversation_id}/messages",
      "POST /api/v1/accounts/{account_id}/webhooks",
      "POST /api/v1/accounts/{account_id}/agents",
    ]) {
      expect(outward.has(held), held).toBe(true);
    }
    // The `*` in a held pattern covers one path segment, so nested look-alikes are not caught by accident.
    expect(outward.has("POST /api/v1/accounts/{account_id}/captain/assistants/{assistant_id}/inboxes")).toBe(false);
  });

  it("covers the whole GlitchTip API and holds notifications, invitations, ingestion, billing and imports", () => {
    const compiled = catalog.get("glitchtip") as CompiledOpenApiEntry;
    expect(compiled.apiBasePath).toBe("");
    expect(compiled.entry.auth).toMatchObject({ type: "header", name: "Authorization", prefix: "Bearer " });
    expect(compiled.entry.excluded).toEqual([]);
    expect(refs(compiled, (operation) => operation.outward)).toEqual(
      expect.arrayContaining([
        "apps_alerts_api_test_project_alert",
        "apps_event_ingest_api_event_store",
        "apps_importer_api_importer",
        "apps_organizations_ext_api_create_organization_member",
        "apps_stripe_api_create_stripe_session",
        "apps_uptime_api_create_monitor",
      ]),
    );
  });

  it("converts the Forgejo Swagger 2.0 and excludes only host-dangerous or unusable operations", () => {
    const compiled = catalog.get("forgejo") as CompiledOpenApiEntry;
    expect(compiled.spec).toMatchObject({ format: "swagger-2", specVersion: "2.0" });
    expect(compiled.apiBasePath).toBe("/api/v1");
    expect(compiled.entry.auth).toMatchObject({ type: "header", name: "Authorization", prefix: "token " });
    expect(compiled.entry.excluded.map((exclusion) => exclusion.operation).sort()).toEqual(
      [
        "activitypubInstanceActorInbox",
        "activitypubPersonInbox",
        "activitypubRepositoryInbox",
        "adminCreateHook",
        "adminCronRun",
        "adminEditHook",
        "repoEditGitHook",
        "userCreateToken",
        "userDeleteAccessToken",
        "userGetTokens",
      ].sort(),
    );
    expect(refs(compiled, (operation) => operation.outward)).toEqual(
      [
        "DispatchWorkflow",
        "adminCreateUser",
        "orgAddTeamMember",
        "orgCreateHook",
        "orgEditHook",
        "repoAddCollaborator",
        "repoAddPushMirror",
        "repoCreateHook",
        "repoCreateRelease",
        "repoCreateReleaseAttachment",
        "repoEditHook",
        "repoEditRelease",
        "repoMergePullRequest",
        "repoMigrate",
        "repoMirrorSync",
        "repoPushMirrorSync",
        "repoTestHook",
        "repoTransfer",
        "userAddEmail",
        "userCreateHook",
        "userEditHook",
      ].sort(),
    );
    expect(compiled.byKey.get("company-box-forgejo.repo-merge-pull-request")).toMatchObject({ outward: true, destructive: true, capability: "connector.admin" });
    expect(compiled.byKey.get("company-box-forgejo.render-markdown")).toMatchObject({ capability: "connector.observe", outward: false });
  });

  it("serves authentik by discovery, drops the multi-tenancy routes the deployed instance lacks and excludes only code-applying or credential-revealing operations", () => {
    const compiled = catalog.get("authentik") as CompiledOpenApiEntry;
    expect(compiled.exposure).toBe("discovery");
    expect(compiled.apiBasePath).toBe("/api/v3");
    expect(rawSpecOperationCount("authentik")).toBe(1113);
    expect(specOperationCount("authentik")).toBe(1099);
    expect(compiled.operations.some((operation) => operation.path.startsWith("/tenants/"))).toBe(false);
    expect(compiled.entry.excluded.map((exclusion) => exclusion.operation).sort()).toEqual(
      [
        "core_tokens_view_key_retrieve",
        "endpoints_agents_enrollment_tokens_view_key_retrieve",
        "managed_blueprints_apply_create",
        "managed_blueprints_create",
        "managed_blueprints_partial_update",
        "managed_blueprints_update",
        "tasks_schedules_send_create",
        "tasks_tasks_retry_create",
      ].sort(),
    );
    // Credential-minting, notification and external-sync operations are held; code-bearing objects need the admin capability.
    const op = (operationId: string) => compiled.operations.find((operation) => operation.operationId === operationId)!;
    for (const held of ["core_users_recovery_email_create", "core_users_set_password_create", "events_transports_test_create", "providers_scim_sync_object_create", "core_tokens_create"]) {
      expect(op(held), held).toMatchObject({ outward: true });
    }
    for (const admin of ["policies_expression_create", "propertymappings_provider_scope_update", "core_users_set_password_create", "rbac_roles_add_user_create"]) {
      expect(op(admin), admin).toMatchObject({ destructive: true, capability: "connector.admin" });
    }
    expect(op("admin_system_create")).toMatchObject({ capability: "connector.observe", write: false });
  });
});
