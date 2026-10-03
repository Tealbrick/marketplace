import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fragment = JSON.parse(
  await readFile(new URL("./registry.fragment.json", import.meta.url), "utf8"),
);
const contract = JSON.parse(
  await readFile(
    new URL("../../contracts/capabilities-host.v1.schema.json", import.meta.url),
    "utf8",
  ),
);

test("routes the Marketplace-owned capability projection through the registry proxy", () => {
  assert.equal(fragment.units.length, 1);
  assert.deepEqual(fragment.contributions, []);

  const projection = fragment.units[0].capabilityProjection;
  assert.deepEqual(projection, {
    gatewayPluginId: "doppelganger-registry",
    recordsPath:
      "/api/plugins/doppelganger-registry/proxy/marketplace/api/plugins/marketplace-hub/records",
  });
  assert.equal(
    projection.recordsPath.startsWith(
      "/api/plugins/" + projection.gatewayPluginId + "/",
    ),
    true,
  );

  const host = contract.properties.host.properties;
  assert.equal(host.lifecycleAuthority.const, "marketplace");
  assert.equal(host.directHermesRole.const, "underlying-adapters-only");
  assert.equal(Object.hasOwn(fragment.units[0], "capabilities"), false);
});
