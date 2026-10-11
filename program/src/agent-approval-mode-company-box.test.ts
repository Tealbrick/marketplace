/**
 * Hand-reviewed hold families of the shipped Company Box entries (entry.json `sensitiveFamilies`) in Assistant mode,
 * through the real app against a fake REST server. The word matcher misses semantics such as listmonk
 * `testCampaignById` (mail to many people); the reviewed family holds it.
 */
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_COMPANY_BOX_CATALOG_DIR, loadCompanyBoxCatalog, type CompiledOpenApiEntry } from "./company-box.js";
import { argumentsFor, fixture } from "./testing/company-box-catalog-harness.js";

const catalog = loadCompanyBoxCatalog(DEFAULT_COMPANY_BOX_CATALOG_DIR);
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function assistant(id: string) {
  const f = await fixture(id, "owner");
  closers.push(f.close);
  f.store.agentModes.updateSetting({ workspaceSlug: "ws-a", agentId: "agent-1", mode: "assistant", actor: "operator:owner-1", now: new Date() });
  const compiled = catalog.get(id) as CompiledOpenApiEntry;
  const run = async (operationId: string) => {
    const operation = compiled.operations.find((candidate) => candidate.operationId === operationId || candidate.ref === operationId)!;
    expect(operation, operationId).toBeTruthy();
    return f.call(operation.key, argumentsFor(id, operation, operation.inputSchema as never), await f.grant(operation.key));
  };
  return { f, run };
}

describe("reviewed Company Box families in Assistant mode", () => {
  it("every reviewed key names an exposed outward operation of a shipped entry (the catalog loads clean)", () => {
    expect(catalog.loadErrors).toEqual([]);
    for (const entry of catalog.entries) expect(entry.errors, entry.entry.id).toEqual([]);
    const listmonk = catalog.get("listmonk") as CompiledOpenApiEntry;
    expect(listmonk.operations.find((operation) => operation.operationId === "testCampaignById")).toMatchObject({ outward: true, sensitiveFamily: "bulk" });
  });

  it("listmonk: campaign and multi-recipient mail wait (bulk); a subscriber change runs with a receipt; owner can turn bulk off", async () => {
    const { f, run } = await assistant("listmonk");
    for (const operationId of ["testCampaignById", "transactWithSubscriber"]) {
      const held = await run(operationId);
      expect(held.statusCode, `${operationId}: ${held.body}`).toBe(202);
      expect(held.json(), operationId).toMatchObject({ heldBecause: "sensitive:bulk" });
    }
    const before = f.rest.requests.length;
    const created = await run("createSubscriber");
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().receipt).toMatchObject({ status: "succeeded", mode: "assistant" });
    expect(f.rest.requests.length).toBe(before + 1);
    // bulk is overridable (not locked): with the owner's setting off, the test send runs.
    f.store.agentModes.setFamily({ workspaceSlug: "ws-a", familyId: "bulk", enabled: false, actor: "operator:owner-1", now: new Date() });
    expect((await run("testCampaignById")).statusCode).toBe(200);
  });

  it("postiz: posting runs; deletes wait (curated destructive)", async () => {
    const { run } = await assistant("postiz");
    expect((await run("PublicIntegrationsController_createPost")).statusCode).toBe(200);
    expect((await run("PublicIntegrationsController_deleteChannel")).json()).toMatchObject({ heldBecause: "destructive" });
  });

  it("nextcloud and pretix: webhooks wait (access-sharing); gift cards wait (money, locked)", async () => {
    const nextcloud = await assistant("nextcloud");
    expect((await nextcloud.run("webhooks-create")).json()).toMatchObject({ heldBecause: "sensitive:access-sharing" });
    expect((await nextcloud.run("users-resend-welcome-message")).statusCode).toBe(200);
    const pretix = await assistant("pretix");
    pretix.f.store.agentModes.setFamily({ workspaceSlug: "ws-a", familyId: "money", enabled: false, actor: "operator:owner-1", now: new Date() });
    expect((await pretix.run("giftcards.create")).json()).toMatchObject({ heldBecause: "sensitive:money" });
    expect((await pretix.run("sendmail_rules.create")).json()).toMatchObject({ heldBecause: "sensitive:bulk" });
    expect((await pretix.run("events.create")).statusCode).toBe(200);
  });
});

describe("QA reclassifications (held in Assistant mode)", () => {
  const cases: Record<string, Array<[string, string]>> = {
    chatwoot: [["macros-execute", "destructive"], ["integrations-hooks-process-event", "destructive"], ["inboxCreation", "access-sharing"], ["updateInbox", "access-sharing"]],
    postiz: [["PublicIntegrationsController_triggerIntegrationTool", "destructive"]],
    forgejo: [["DispatchWorkflow", "destructive"], ["repoPushMirrorSync", "access-sharing"], ["repoMigrate", "access-sharing"]],
    documenso: [["document-distribute", "money"], ["document-redistribute", "money"], ["envelope-distribute", "money"], ["envelope-redistribute", "money"]],
    pretix: [["invoices.transmit", "money"], ["invoices.retransmit", "money"], ["invoices.transmit_organizer", "money"], ["invoices.retransmit_organizer", "money"]],
    authentik: [["flows_executor_solve", "access-sharing"]],
  };
  for (const [id, operations] of Object.entries(cases)) {
    it(`${id}: ${operations.map(([operationId]) => operationId).join(", ")} wait`, async () => {
      const { f, run } = await assistant(id);
      const before = f.rest.requests.length;
      for (const [operationId, family] of operations) {
        const held = await run(operationId);
        expect(held.statusCode, `${operationId}: ${held.body}`).toBe(202);
        expect(held.json(), operationId).toMatchObject({ heldBecause: `sensitive:${family}` });
      }
      expect(f.rest.requests.length).toBe(before);
    });
  }
});
