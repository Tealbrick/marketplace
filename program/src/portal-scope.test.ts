import { createSign, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createPortalAgentScopeVerifier,
} from "./portal-scope.js";

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signedToken(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  kid: string,
  claims: Record<string, unknown>,
) {
  const header = encode({ alg: "ES256", kid, typ: "JWT" });
  const payload = encode(claims);
  const signed = `${header}.${payload}`;
  const signer = createSign("SHA256");
  signer.update(signed);
  signer.end();
  const signature = signer
    .sign({ key: privateKey, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${signed}.${signature}`;
}

describe("Portal agent scope verifier", () => {
  it("verifies Portal ES256 agent and attachment JWTs against the JWKS contract", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const nowSeconds = 1_800_000_000;
    const issuer = "https://portal.example";
    const kid = "portal-test-key";
    const agentToken = signedToken(privateKey, kid, {
      iss: issuer,
      iat: nowSeconds - 5,
      exp: nowSeconds + 3600,
      org: "atlas",
      sub: "agent-1",
      kind: "agent",
    });
    const attachmentToken = signedToken(privateKey, kid, {
      iss: issuer,
      iat: nowSeconds - 5,
      exp: nowSeconds + 295,
      aud: "marketplace",
      typ: "attachment",
      status: "active",
      orgId: "atlas",
      sub: "agent-1",
      jti: "attachment-1",
      capabilities: ["connector.observe"],
    });
    let jwksReads = 0;
    const verifier = createPortalAgentScopeVerifier({
      issuer,
      now: () => nowSeconds * 1000,
      fetchImpl: async () => {
        jwksReads += 1;
        return new Response(
          JSON.stringify({
            keys: [
              {
                ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
                kid,
                alg: "ES256",
                use: "sig",
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    await expect(
      verifier({
        agentToken,
        attachmentToken,
        audience: "marketplace",
        requiredCapability: "connector.observe",
      }),
    ).resolves.toMatchObject({
      organizationId: "atlas",
      agentId: "agent-1",
      attachmentId: "attachment-1",
      capabilities: ["connector.observe"],
      expiresAt: nowSeconds + 295,
    });
    expect(jwksReads).toBe(1);
  });

  it("fails closed when the Portal attachment lacks the requested capability", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const nowSeconds = 1_800_000_000;
    const issuer = "https://portal.example";
    const kid = "portal-test-key";
    const base = {
      iss: issuer,
      iat: nowSeconds - 5,
      exp: nowSeconds + 295,
    };
    const agentToken = signedToken(privateKey, kid, {
      ...base,
      exp: nowSeconds + 3600,
      org: "atlas",
      sub: "agent-1",
      kind: "agent",
    });
    const attachmentToken = signedToken(privateKey, kid, {
      ...base,
      aud: "marketplace",
      typ: "attachment",
      status: "active",
      orgId: "atlas",
      sub: "agent-1",
      jti: "attachment-1",
      capabilities: ["connector.observe"],
    });
    const verifier = createPortalAgentScopeVerifier({
      issuer,
      now: () => nowSeconds * 1000,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            keys: [
              {
                ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
                kid,
                alg: "ES256",
                use: "sig",
              },
            ],
          }),
          { status: 200 },
        ),
    });

    await expect(
      verifier({
        agentToken,
        attachmentToken,
        audience: "marketplace",
        requiredCapability: "connector.dispatch",
      }),
    ).rejects.toMatchObject({
      code: "portal_capability_denied",
      statusCode: 403,
    });
  });
});
