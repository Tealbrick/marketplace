import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { buildMarketplaceOpenApi } from "./openapi.js";

const PROGRAM = { id: "marketplace", name: "Marketplace", version: "0.1.0" } as const;

export async function registerMarketplaceFrontend(app: FastifyInstance) {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web-dist");
  const webIndexPath = path.join(webRoot, "index.html");

  if (fs.existsSync(webIndexPath)) {
    await app.register(fastifyStatic, {
      root: path.join(webRoot, "assets"),
      prefix: "/assets/",
      immutable: true,
      maxAge: "1y",
    });
  }

  const sendIndex = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!fs.existsSync(webIndexPath)) {
      return null;
    }
    return reply.type("text/html; charset=utf-8").send(fs.readFileSync(webIndexPath, "utf8"));
  };

  app.get("/embed", sendIndex);
  app.get("/status", async () => ({
    ok: true,
    program: PROGRAM,
    authorization: {
      browserOperatorRoutes: "operator-session-and-rules-governed",
      operatorSessionRequired: true,
      hubRoutesRequireBearer: true,
      crossAppRoutesRequireBearer: true,
      credentialExposedToBrowser: false,
    },
  }));
  app.get("/bootstrap.json", async () => ({
    program: PROGRAM,
    authorization: {
      browserOperatorRoutes: "operator-session-and-rules-governed",
      operatorSessionRequired: true,
      hubRoutesRequireBearer: true,
      crossAppRoutesRequireBearer: true,
      credentialExposedToBrowser: false,
    },
    surfaces: { standalone: "/", embed: "/embed", openapi: "/openapi.json" },
    contractGaps: {
      browserEnableDisable: "hub-auth-required",
      browserMcpCrud: "hub-auth-required",
      runtimeAdapterExecution: "not-wired",
    },
  }));
  app.get("/openapi.json", async (request) => buildMarketplaceOpenApi(`${request.protocol}://${request.host}`));
  app.get("/swagger.json", async (request) => buildMarketplaceOpenApi(`${request.protocol}://${request.host}`));

  return { sendIndex };
}
