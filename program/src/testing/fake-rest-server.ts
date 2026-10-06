/**
 * In-process fake REST app for Company Box tests. Records every request and
 * echoes it back as JSON unless a route override answers. Not part of the
 * production runtime.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeRestRequest = {
  method: string;
  path: string;
  query: Record<string, string[]>;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** Exact request bytes (binary uploads). */
  raw: Buffer;
};

export type FakeRestRoute = (request: FakeRestRequest, response: ServerResponse) => boolean;

export type FakeRestServerOptions = {
  /** Return true when the request carries valid credentials; otherwise 401. */
  authorize?: (request: FakeRestRequest) => boolean;
  routes?: FakeRestRoute[];
};

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export async function startFakeRestServer(options: FakeRestServerOptions = {}) {
  const requests: FakeRestRequest[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    const query: Record<string, string[]> = {};
    for (const [key, value] of url.searchParams) query[key] = [...(query[key] ?? []), value];
    const raw = await readBody(request);
    const record: FakeRestRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      query,
      headers: request.headers,
      body: raw.toString("utf8"),
      raw,
    };
    requests.push(record);
    if (options.authorize && !options.authorize(record)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    for (const route of options.routes ?? []) {
      if (route(record, response)) return;
    }
    const status = record.method === "POST" ? 201 : record.method === "DELETE" ? 204 : 200;
    if (status === 204) {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(status, { "content-type": "application/json", "x-total-count": "1" });
    response.end(
      JSON.stringify({
        method: record.method,
        path: record.path,
        query: record.query,
        contentType: request.headers["content-type"] ?? null,
        body: record.body ? safeJson(record.body) : null,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
