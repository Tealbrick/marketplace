import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  listingExecutableForAgents,
  MARKETPLACE_AGENT_ACTION_CATALOG_CONTRACT_VERSION,
  publishedAgentActionCatalog,
  resolvePublishedAgentAction,
} from "./agent-action-catalog.js";
import { applyScopedResource } from "./agent-grant-contract.js";
import { buildComposioListingFromTools } from "./connectors.js";
import { SqliteMarketplaceStore } from "./store.js";
import type { MarketplaceListing } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const WORKSPACE = "tenant-1";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-action-catalog-"));
  roots.push(root);
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
  const github = buildComposioListingFromTools({
    toolkit: "github",
    pluginId: "github-composio",
    displayName: "GitHub",
    tools: [
      { name: "GITHUB_LIST_REPOSITORIES", description: "List repositories." },
      {
        name: "GITHUB_CREATE_ISSUE",
        displayName: "Create issue",
        description: "Open an issue in a repository.",
        input_parameters: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
            user_id: { type: "string" },
            connected_account_id: { type: "string" },
          },
        },
      },
    ],
  });
  store.upsertListing(github);
  store.registerPlugin(github.pluginId);
  store.install(WORKSPACE, github.pluginId);
  store.bindCapability({ workspaceSlug: WORKSPACE, pluginId: github.pluginId, capability: "connector.observe", enabled: true });
  store.bindCapability({ workspaceSlug: WORKSPACE, pluginId: github.pluginId, capability: "connector.dispatch", enabled: true });
  store.upsertConnection({
    workspaceSlug: WORKSPACE,
    pluginId: github.pluginId,
    provider: "github",
    backend: "composio",
    state: "connected",
    detail: "fixture",
    metadata: { connectedAccountId: "ca_1", userId: "composio-user", accessToken: "secret-token" },
  });
  return { store, github };
}

describe("published agent action catalog", () => {
  it("publishes installed, connected, enabled actions and keeps the legacy GitHub entry unchanged", async () => {
    const { store } = await fixture();
    expect(MARKETPLACE_AGENT_ACTION_CATALOG_CONTRACT_VERSION).toBe(
      "doppelganger.marketplace.agent-action-catalog.v1",
    );
    const catalog = publishedAgentActionCatalog({ store, workspaceSlug: WORKSPACE });
    expect(catalog.map((entry) => entry.actionKey)).toEqual([
      "github.create.issue",
      "github.list.repositories",
    ]);
    const legacy = catalog.find((entry) => entry.actionKey === "github.list.repositories");
    expect(legacy).toEqual({
      pluginId: "github-composio",
      pluginName: "GitHub",
      provider: "github",
      actionKey: "github.list.repositories",
      label: "List Repositories",
      description: "List repositories.",
      capability: "connector.observe",
      resourceKind: "github.connected-account",
      mode: "connected-account",
      accounts: [{ accountId: "ca_1" }],
      allowedArguments: [
        "page",
        "sort",
        "type",
        "since",
        "before",
        "per_page",
        "direction",
        "visibility",
        "affiliation",
      ],
      toolName: "GITHUB_LIST_REPOSITORIES",
    });
    const dispatch = catalog.find((entry) => entry.actionKey === "github.create.issue");
    expect(dispatch).toMatchObject({
      label: "Create issue",
      capability: "connector.dispatch",
      resourceKind: "github.connected-account",
      toolName: "GITHUB_CREATE_ISSUE",
      // Schema property names, minus identity-overriding arguments.
      allowedArguments: ["body", "owner", "repo", "title"],
    });
    expect(JSON.stringify(catalog)).not.toContain("secret-token");
    expect(JSON.stringify(catalog)).not.toContain("composio-user");
  });

  it("returns null allowedArguments when no input schema was stored", async () => {
    const { store } = await fixture();
    const listing = buildComposioListingFromTools({
      toolkit: "slack",
      pluginId: "slack-composio",
      tools: [{ name: "SLACK_LIST_CHANNELS" }],
    });
    store.upsertListing(listing);
    store.registerPlugin(listing.pluginId);
    store.install(WORKSPACE, listing.pluginId);
    store.bindCapability({ workspaceSlug: WORKSPACE, pluginId: listing.pluginId, capability: "connector.observe", enabled: true });
    store.upsertConnection({ workspaceSlug: WORKSPACE, pluginId: listing.pluginId, provider: "slack", backend: "composio", state: "connected", detail: "fixture", metadata: { connectedAccountId: "ca_slack", accountLabel: "Acme workspace" } });
    expect(
      resolvePublishedAgentAction({ store, workspaceSlug: WORKSPACE, pluginId: "slack-composio", actionKey: "slack.list.channels" }),
    ).toMatchObject({
      resourceKind: "slack.connected-account",
      allowedArguments: null,
      accounts: [{ accountId: "ca_slack", label: "Acme workspace" }],
    });
  });

  it("filters out uninstalled, disabled, unbound, disconnected, unregistered and non-executable listings", async () => {
    const resolve = (store: SqliteMarketplaceStore, actionKey = "github.list.repositories") =>
      resolvePublishedAgentAction({ store, workspaceSlug: WORKSPACE, pluginId: "github-composio", actionKey });

    {
      const { store } = await fixture();
      expect(resolve(store)).not.toBeNull();
      expect(resolvePublishedAgentAction({ store, workspaceSlug: "other-tenant", pluginId: "github-composio", actionKey: "github.list.repositories" })).toBeNull();
      expect(resolve(store, "github.unknown.action")).toBeNull();
      store.uninstall(WORKSPACE, "github-composio");
      expect(resolve(store)).toBeNull();
      expect(publishedAgentActionCatalog({ store, workspaceSlug: WORKSPACE })).toEqual([]);
    }
    {
      const { store } = await fixture();
      store.bindAction({ workspaceSlug: WORKSPACE, pluginId: "github-composio", actionKey: "github.list.repositories", enabled: false });
      expect(resolve(store)).toBeNull();
      expect(resolve(store, "github.create.issue")).not.toBeNull();
    }
    {
      const { store } = await fixture();
      store.bindCapability({ workspaceSlug: WORKSPACE, pluginId: "github-composio", capability: "connector.dispatch", enabled: false });
      expect(resolve(store, "github.create.issue")).toBeNull();
      expect(resolve(store)).not.toBeNull();
    }
    {
      const { store } = await fixture();
      store.upsertConnection({ workspaceSlug: WORKSPACE, pluginId: "github-composio", provider: "github", backend: "composio", state: "disconnected", detail: "gone", metadata: { connectedAccountId: "ca_1" } });
      expect(resolve(store)).toBeNull();
    }
    {
      const { store } = await fixture();
      store.unregisterPlugin("github-composio");
      expect(resolve(store)).toBeNull();
    }
    {
      const { store, github } = await fixture();
      const mcp: MarketplaceListing = { ...github, executionOwner: "mcp" };
      expect(listingExecutableForAgents(mcp)).toBe(false);
      expect(listingExecutableForAgents(github)).toBe(true);
      store.upsertListing(mcp);
      expect(resolve(store)).toBeNull();
    }
  });

  it("binds scoped arguments to the live entry and never lets callers override the account", async () => {
    const { store } = await fixture();
    const entry = resolvePublishedAgentAction({ store, workspaceSlug: WORKSPACE, pluginId: "github-composio", actionKey: "github.create.issue" });
    const grant = {
      pluginId: "github-composio",
      actionKey: "github.create.issue",
      accountId: "ca_1",
      resourceKind: "github.connected-account",
      resourceRef: "account:ca_1",
    };
    expect(applyScopedResource({ action: { type: "github.create.issue", owner: "o", title: "t" }, grant, entry })).toMatchObject({ ok: true });
    expect(applyScopedResource({ action: { type: "github.create.issue", labels: ["x"] }, grant, entry })).toEqual({ ok: false, error: "provider_argument_invalid" });
    expect(applyScopedResource({ action: { type: "github.create.issue", user_id: "someone-else" }, grant, entry })).toEqual({ ok: false, error: "provider_argument_invalid" });
    expect(applyScopedResource({ action: { type: "github.create.issue" }, grant: { ...grant, resourceRef: "account:ca_2" }, entry })).toEqual({ ok: false, error: "resource_mapping_unsupported" });
    expect(applyScopedResource({ action: { type: "github.create.issue" }, grant: { ...grant, accountId: "ca_2", resourceRef: "account:ca_2" }, entry })).toEqual({ ok: false, error: "agent_grant_connection_mismatch" });
    expect(applyScopedResource({ action: { type: "github.create.issue" }, grant, entry: null })).toEqual({ ok: false, error: "resource_mapping_unsupported" });

    const schemaless = { ...entry!, allowedArguments: null };
    expect(applyScopedResource({ action: { type: "github.create.issue", anything: 1 }, grant, entry: schemaless })).toMatchObject({ ok: true });
    expect(applyScopedResource({ action: { type: "github.create.issue", connectedAccountId: "ca_9" }, grant, entry: schemaless })).toEqual({ ok: false, error: "provider_argument_invalid" });
  });
});
