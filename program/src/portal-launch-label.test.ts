import { describe, expect, it } from "vitest";

import { MarketplaceOperatorSessionManager } from "./operator-auth.js";
import { createPortalHandoffClient } from "./portal-handoff.js";

const redeemPayload = (extra: Record<string, unknown> = {}) => ({
  schema: 1,
  authorized: true,
  product: "marketplace",
  deploymentId: "deployment-1",
  workspaceId: "3f32db87-6f74-4ecf-b7b8-8c72c54f30a3",
  orgId: "org-1",
  productTenantId: "3f32db87-6f74-4ecf-b7b8-8c72c54f30a3",
  userId: "user-1",
  endpoint: "https://marketplace.example.test",
  session: "s".repeat(43),
  expiresAt: Date.now() + 60_000,
  ...extra,
});

function clientReturning(payload: unknown) {
  return createPortalHandoffClient({
    issuer: "https://portal.example.test",
    instanceProof: "p".repeat(43),
    fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
}

describe("Portal launch workspace label", () => {
  it("carries a cleaned, bounded workspace name when Portal sends one", async () => {
    const session = await clientReturning(redeemPayload({ workspaceName: "  Polygon\u0007face  " })).redeemLaunchTicket({ deploymentId: "deployment-1", ticket: "t".repeat(43) });
    expect(session.workspaceName).toBe("Polygonface");
    const long = await clientReturning(redeemPayload({ workspaceName: "x".repeat(300) })).redeemLaunchTicket({ deploymentId: "deployment-1", ticket: "t".repeat(43) });
    expect(long.workspaceName).toHaveLength(120);
  });

  it("omits the label for older Portals or non-string values", async () => {
    for (const extra of [{}, { workspaceName: 42 }, { workspaceName: "   " }]) {
      const session = await clientReturning(redeemPayload(extra)).redeemLaunchTicket({ deploymentId: "deployment-1", ticket: "t".repeat(43) });
      expect("workspaceName" in session).toBe(false);
    }
  });

  it("puts the label on the operator principal without changing its scope", () => {
    const sessions = new MarketplaceOperatorSessionManager({ accessToken: "a".repeat(32), operatorId: "op", organizationId: "default" });
    const named = sessions.issuePortalSession({ id: "user-1", organizationId: "ws-1", organizationName: " Polygonface " });
    expect(named.status.principal).toEqual({ kind: "operator", id: "user-1", organizationId: "ws-1", organizationName: "Polygonface" });
    const unnamed = sessions.issuePortalSession({ id: "user-1", organizationId: "ws-1" });
    expect(unnamed.status.principal).toEqual({ kind: "operator", id: "user-1", organizationId: "ws-1" });
  });
});
