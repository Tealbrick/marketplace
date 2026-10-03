import { describe, expect, it } from "vitest";

import { resolvePortalRuntimeConfiguration } from "./portal-config.js";

describe("Portal deployment environment compatibility", () => {
  it("accepts the current proof/issuer names and the Portal provisioner aliases", () => {
    expect(
      resolvePortalRuntimeConfiguration({
        env: {
          MARKETPLACE_PORTAL_URL: "https://portal.test/",
          MARKETPLACE_PORTAL_INSTANCE_TOKEN: "instance-proof",
          MARKETPLACE_PORTAL_DEPLOYMENT_ID: "deployment-1",
          MARKETPLACE_PORTAL_ORG_ID: "portal-org-1",
          MARKETPLACE_PORTAL_WORKSPACE_ID: "workspace-1",
        },
      }),
    ).toEqual({
      issuerUrl: "https://portal.test",
      instanceProof: "instance-proof",
      deploymentId: "deployment-1",
      portalOrgId: "portal-org-1",
      workspaceId: "workspace-1",
    });
  });

  it("rejects conflicting issuer or proof aliases without exposing their values", () => {
    expect(() =>
      resolvePortalRuntimeConfiguration({
        env: {
          MARKETPLACE_PORTAL_ISSUER_URL: "https://portal-a.test",
          MARKETPLACE_PORTAL_URL: "https://portal-b.test",
        },
      }),
    ).toThrow("Portal issuer URL configuration conflicts");
    expect(() =>
      resolvePortalRuntimeConfiguration({
        env: {
          MARKETPLACE_PORTAL_INSTANCE_PROOF: "proof-a",
          MARKETPLACE_PORTAL_INSTANCE_TOKEN: "proof-b",
        },
      }),
    ).toThrow("Portal instance proof configuration conflicts");
    expect(() =>
      resolvePortalRuntimeConfiguration({
        env: {
          MARKETPLACE_PORTAL_INSTANCE_PROOF: "proof-a",
          MARKETPLACE_PORTAL_INSTANCE_TOKEN: "proof-b",
        },
      }),
    ).not.toThrow(/proof-a|proof-b/u);
  });
});
