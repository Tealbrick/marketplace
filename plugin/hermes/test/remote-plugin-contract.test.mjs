import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const hermesPluginRoot = path.resolve(import.meta.dirname, "..");
const remotePluginDir = path.join(
  hermesPluginRoot,
  "remote-plugin",
  "marketplace",
);

test("remote Hermes marketplace plugin exposes agent capability tools with schemas", async () => {
  assert.ok(existsSync(path.join(remotePluginDir, "plugin.yaml")));
  assert.ok(existsSync(path.join(remotePluginDir, "__init__.py")));
  assert.ok(existsSync(path.join(remotePluginDir, "tools.py")));

  const tempDir = await mkdtemp(path.join(tmpdir(), "dgl-marketplace-plugin-"));
  const probe = path.join(tempDir, "probe.py");
  await writeFile(
    probe,
    `
import importlib.util
import json
import pathlib
import sys

plugin_dir = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location(
    "doppelganger_marketplace_plugin",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
module.__package__ = "doppelganger_marketplace_plugin"
sys.modules["doppelganger_marketplace_plugin"] = module
spec.loader.exec_module(module)

class FakeContext:
    def __init__(self):
        self.tools = []

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)

ctx = FakeContext()
module.register(ctx)
print(json.dumps([
    {
        "name": tool["name"],
        "toolset": tool["toolset"],
        "handler": callable(tool["handler"]),
        "schema": tool["schema"],
    }
    for tool in ctx.tools
], sort_keys=True))
`,
  );

  const result = spawnSync("python3", [probe, remotePluginDir], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const tools = JSON.parse(result.stdout);
  const toolNames = tools.map((tool) => tool.name);

  assert.ok(toolNames.includes("marketplace_agent_capabilities"));
  assert.ok(toolNames.includes("marketplace_agent_tool_call"));
  assert.ok(toolNames.includes("marketplace_action_bind"));
  assert.ok(toolNames.includes("marketplace_composio_tools"));
  assert.ok(tools.every((tool) => tool.handler === true));
  assert.deepEqual(
    [...new Set(tools.map((tool) => tool.toolset))],
    ["marketplace"],
  );

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(
    byName.marketplace_agent_tool_call.schema.parameters.required,
    ["toolName", "pluginId", "workspaceSlug"],
  );
  assert.deepEqual(
    byName.marketplace_plugin_execute.schema.parameters.required,
    ["pluginId", "workspaceSlug", "capability", "action"],
  );
  assert.deepEqual(
    byName.marketplace_listing_get.schema.parameters.required,
    ["pluginId"],
  );
  assert.deepEqual(
    byName.marketplace_composio_tools.schema.parameters.required,
    ["toolkit"],
  );
});
