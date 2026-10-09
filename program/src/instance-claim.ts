import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const INSTANCE_CLAIM_IDENTITY_FILE = "instance-claim-identity.json";
export const INSTANCE_CLAIM_TTL_SECONDS = 300;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NONCE = /^[A-Za-z0-9_-]{16,256}$/u;
const UUID = /^[a-f0-9-]{36}$/u;

export class InstanceClaimError extends Error {
  constructor(
    readonly code:
      | "invalid_claim_challenge"
      | "claim_issuer_mismatch"
      | "claim_scope_unknown",
  ) {
    super(code);
  }
}

export type InstanceClaimPublicJwk = { kty: "OKP"; crv: "Ed25519"; x: string };

function canonicalIssuer(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password) return null;
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Operator-only proof of app control. It lets Portal register this Marketplace
 * as a verified runtime app. It is never an entitlement, a grant, or agent
 * authorization. The Ed25519 private key never leaves this object.
 */
export class MarketplaceInstanceClaim {
  readonly instanceId: string;
  readonly publicJwk: InstanceClaimPublicJwk;
  private readonly key: KeyObject;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const filename = path.join(dataDir, INSTANCE_CLAIM_IDENTITY_FILE);
    if (!existsAsFile(filename)) {
      // Create once, atomically, and never overwrite: a restart or upgrade
      // must keep the same identity. link() fails if the target exists.
      const { privateKey } = generateKeyPairSync("ed25519");
      const staging = `${filename}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(
        staging,
        JSON.stringify({
          version: 1,
          instanceId: randomUUID(),
          privateJwk: privateKey.export({ format: "jwk" }),
        }),
        { mode: 0o600, flag: "wx" },
      );
      try {
        linkSync(staging, filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        unlinkSync(staging);
      }
    }
    const stat = lstatSync(filename);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16_384) {
      throw new Error("Unsafe Marketplace claim identity storage");
    }
    try {
      const identity = JSON.parse(readFileSync(filename, "utf8")) as {
        version?: unknown;
        instanceId?: unknown;
        privateJwk?: { crv?: unknown };
      };
      if (
        identity.version !== 1 ||
        typeof identity.instanceId !== "string" ||
        !UUID.test(identity.instanceId) ||
        identity.privateJwk?.crv !== "Ed25519"
      ) {
        throw new Error();
      }
      this.key = createPrivateKey({ key: identity.privateJwk as never, format: "jwk" });
      this.instanceId = identity.instanceId;
      const exported = createPublicKey(this.key).export({ format: "jwk" });
      if (exported.kty !== "OKP" || exported.crv !== "Ed25519" || typeof exported.x !== "string") {
        throw new Error();
      }
      this.publicJwk = { kty: "OKP", crv: "Ed25519", x: exported.x };
    } catch {
      throw new Error("Invalid Marketplace claim identity storage");
    }
  }

  /**
   * The one claim signing key, for the manifest claim handler (`manifest-claim.ts`) only, so both claim
   * paths sign with the same key under the same instance id. The KeyObject is never serialized or logged.
   */
  claimSigningKey(): KeyObject {
    return this.key;
  }

  /**
   * Sign one Portal challenge. The caller supplies the Portal issuer and the
   * company (workspace) this instance is configured for; any other value is
   * rejected, so a stolen instance token cannot mint proofs for other scopes.
   */
  signChallenge(
    input: unknown,
    expected: { readonly portalIssuer: string; readonly companyId: string },
    now = Date.now(),
  ) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new InstanceClaimError("invalid_claim_challenge");
    }
    const value = input as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "companyId,nonce,portalIssuer") {
      throw new InstanceClaimError("invalid_claim_challenge");
    }
    if (typeof value.nonce !== "string" || !NONCE.test(value.nonce)) {
      throw new InstanceClaimError("invalid_claim_challenge");
    }
    const issuer = canonicalIssuer(value.portalIssuer);
    if (!issuer) throw new InstanceClaimError("invalid_claim_challenge");
    if (typeof value.companyId !== "string" || !IDENTIFIER.test(value.companyId)) {
      throw new InstanceClaimError("invalid_claim_challenge");
    }
    if (issuer !== expected.portalIssuer) throw new InstanceClaimError("claim_issuer_mismatch");
    if (value.companyId !== expected.companyId) throw new InstanceClaimError("claim_scope_unknown");
    const iat = Math.floor(now / 1000);
    const encode = (part: unknown) => Buffer.from(JSON.stringify(part)).toString("base64url");
    const content = `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({
      typ: "tealbrick-app-claim",
      version: 1,
      aud: issuer,
      nonce: value.nonce,
      instanceId: this.instanceId,
      companyId: value.companyId,
      iat,
      exp: iat + INSTANCE_CLAIM_TTL_SECONDS,
    })}`;
    return {
      proof: `${content}.${sign(null, Buffer.from(content), this.key).toString("base64url")}`,
      publicJwk: this.publicJwk,
      instanceId: this.instanceId,
      companyId: value.companyId,
    };
  }
}

function existsAsFile(filename: string) {
  try {
    lstatSync(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
