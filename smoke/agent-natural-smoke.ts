import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildMarketplaceApp } from "../program/src/app.js";
import { SqliteMarketplaceStore } from "../program/src/store.js";

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tealbrick-marketplace-agent-smoke-"));
  const dbPath = path.join(root, "data", "marketplace.sqlite");
  const logPath = path.join(root, "logs", "marketplace-debug.jsonl");
  const decisions = new Map<string, "allow" | "deny">([
    ["agent-denied-trace", "deny"],
    ["agent-allowed-trace", "allow"],
  ]);
  const providerCalls: unknown[] = [];
  const serviceToken = "marketplace-agent-smoke-service-token";
  const workspaceSlug = "agent-smoke";

  const store = new SqliteMarketplaceStore(dbPath, { logPath, debug: true });
  const app = await buildMarketplaceApp({
    store,
    debug: true,
    logPath,
    internalAuthToken: serviceToken,
    organizationId: workspaceSlug,
    env: { COMPOSIO_API_KEY: "marketplace-agent-smoke-composio-key" },
    providerFetch: async (input, init) => {
      if (String(input).includes("/tools/execute/GITHUB_LIST_REPOSITORIES")) {
        providerCalls.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ data: [{ name: "Doppelganger/agent-smoke-provider" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    },
    rulesClient: async (input) => ({
      effect: decisions.get(String(input.payload.traceId)) ?? "allow",
      decisionId: `rules-${String(input.payload.traceId ?? "default")}`,
      reason: decisions.get(String(input.payload.traceId)) === "deny" ? "agent smoke denial" : undefined,
    }),
  });

  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  async function requestJson(pathname: string, init?: RequestInit) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    const body = await response.json() as unknown;
    return { response, body };
  }

  try {
  const initial = await requestJson("/api/agent/capabilities?workspaceSlug=agent-smoke");
  if (initial.response.status !== 200) {
    throw new Error(`initial discovery failed ${initial.response.status}`);
  }
  await requestJson("/api/marketplace/provider-health?workspaceSlug=agent-smoke", {
    headers: { "x-trace-id": "provider-health-trace" },
  });

  await requestJson("/api/marketplace/catalog/composio/import", {
    method: "POST",
    body: JSON.stringify({
      workspaceSlug,
      actorId: "agent-smoke",
      toolkit: "github",
      pluginId: "github-composio",
      tools: [{ name: "GITHUB_LIST_REPOSITORIES", description: "List GitHub repositories." }],
      autoEnable: true,
    }),
  });
  store.upsertConnection({ workspaceSlug, pluginId: "github-composio", provider: "github", backend: "composio", state: "connected", detail: "Smoke connected account", metadata: { connectedAccountId: "ca_agent_smoke" } });

  const discovered = await requestJson("/api/agent/capabilities?workspaceSlug=agent-smoke");
  const capabilities = (discovered.body as { capabilities?: Array<{ toolName?: string }> }).capabilities ?? [];
  if (!capabilities.some((capability) => capability.toolName === "marketplace.github.list.repositories")) {
    throw new Error(`agent capability discovery did not expose marketplace.github.list.repositories: ${JSON.stringify(discovered.body)}`);
  }

  const denied = await requestJson("/api/agent/tools/marketplace.github.list.repositories", {
    method: "POST",
    headers: { "x-trace-id": "agent-denied-trace" },
    body: JSON.stringify({
      workspaceSlug: "agent-smoke",
      actorId: "agent-smoke",
      pluginId: "github-composio",
      input: { owner: "Doppelganger" },
    }),
  });
  if (denied.response.status !== 403) {
    throw new Error(`expected denied execution to return 403: ${JSON.stringify(denied.body)}`);
  }

  const allowed = await requestJson("/api/agent/tools/marketplace.github.list.repositories", {
    method: "POST",
    headers: { "x-trace-id": "agent-allowed-trace" },
    body: JSON.stringify({
      workspaceSlug: "agent-smoke",
      actorId: "agent-smoke",
      pluginId: "github-composio",
      input: { owner: "Doppelganger" },
    }),
  });
  if (allowed.response.status !== 200) {
    throw new Error(`expected allowed execution to return 200: ${JSON.stringify(allowed.body)}`);
  }
  if (providerCalls.length !== 1) {
    throw new Error(`expected one mocked provider call, saw ${providerCalls.length}`);
  }

  await requestJson("/api/marketplace/plugins/github-composio/uninstall", {
    method: "POST",
    headers: { "x-trace-id": "agent-uninstall-trace" },
    body: JSON.stringify({ workspaceSlug: "agent-smoke", actorId: "agent-smoke" }),
  });

  const events = await requestJson("/api/debug/events?workspaceSlug=agent-smoke");
  const eventTypes = new Set((events.body as { events?: Array<{ type?: string }> }).events?.map((event) => event.type));
  for (const expected of [
    "marketplace.provider.health",
    "marketplace.composio.toolkit.imported",
    "marketplace.plugin.uninstalled",
    "marketplace.execution.requested",
    "marketplace.execution.denied",
    "marketplace.execution.completed",
  ]) {
    if (!eventTypes.has(expected)) {
      throw new Error(`missing event family ${expected}: ${JSON.stringify(events.body)}`);
    }
  }

  const logText = await readFile(logPath, "utf8");
  if (!logText.includes("agent-denied-trace") || !logText.includes("agent-allowed-trace")) {
    throw new Error(`debug log did not include expected trace ids: ${logPath}`);
  }

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    dbPath,
    logPath,
    discoveredTools: capabilities.map((capability) => capability.toolName),
    providerCalls: providerCalls.length,
  }, null, 2));
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
