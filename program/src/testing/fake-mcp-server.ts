/**
 * In-process fake remote MCP server for tests and the E2E fixture. Speaks
 * both the streamable-http transport (`/mcp`) and the legacy HTTP+SSE
 * transport (`/sse` + `/messages`). Not part of the production runtime.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeMcpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export const FAKE_MCP_TOOLS: FakeMcpTool[] = [
  {
    name: "echo",
    title: "Echo",
    description: "Echo the arguments back.",
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_issue",
    description: "Create an issue.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
  {
    name: "Delete Everything!",
    description: "Destructive fixture tool.",
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "fail_tool",
    description: "Always reports a tool error.",
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

export type FakeMcpRequestLog = {
  method: string;
  path: string;
  rpcMethod?: string;
  headers: Record<string, string | string[] | undefined>;
};

export type FakeMcpServerOptions = {
  /** Require this header (lowercase name) with this exact value, else 401. */
  requiredHeader?: { name: string; value: string };
  tools?: FakeMcpTool[];
  /** Override the legacy SSE endpoint event payload. */
  legacyEndpoint?: string;
  pageSize?: number;
  /** Fixed port (E2E fixture); defaults to an ephemeral port. */
  port?: number;
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export async function startFakeMcpServer(options: FakeMcpServerOptions = {}) {
  const tools = options.tools ?? FAKE_MCP_TOOLS;
  const pageSize = options.pageSize ?? 2;
  const requests: FakeMcpRequestLog[] = [];
  const legacyStreams = new Map<string, ServerResponse>();
  let sessionCounter = 0;

  const authorized = (request: IncomingMessage) =>
    !options.requiredHeader ||
    request.headers[options.requiredHeader.name] === options.requiredHeader.value;

  const handleRpc = (message: Record<string, unknown>) => {
    const id = message.id;
    const params = (message.params ?? {}) as Record<string, unknown>;
    switch (message.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-mcp", version: "1.0.0" },
          },
        };
      case "tools/list": {
        const start = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        const page = tools.slice(start, start + pageSize);
        const next = start + pageSize < tools.length ? String(start + pageSize) : undefined;
        return { jsonrpc: "2.0", id, result: { tools: page, ...(next ? { nextCursor: next } : {}) } };
      }
      case "tools/call": {
        const name = String(params.name);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (name === "fail_tool") {
          return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "upstream exploded: internal detail" }] } };
        }
        if (!tools.some((tool) => tool.name === name)) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${name}` } };
        }
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(args) }], structuredContent: { tool: name, arguments: args } },
        };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    const body = request.method === "POST" ? await readBody(request) : "";
    let message: Record<string, unknown> | null = null;
    try {
      message = body ? (JSON.parse(body) as Record<string, unknown>) : null;
    } catch {
      message = null;
    }
    requests.push({
      method: request.method ?? "",
      path: url.pathname,
      ...(typeof message?.method === "string" ? { rpcMethod: message.method } : {}),
      headers: { ...request.headers },
    });
    if (!authorized(request)) {
      response.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
      return;
    }

    if (url.pathname === "/mcp") {
      if (request.method === "DELETE") {
        response.writeHead(200).end();
        return;
      }
      if (request.method !== "POST" || !message) {
        response.writeHead(405).end();
        return;
      }
      if (!("id" in message)) {
        response.writeHead(202).end();
        return;
      }
      const reply = handleRpc(message);
      if (message.method === "initialize") {
        sessionCounter += 1;
        response
          .writeHead(200, { "content-type": "application/json", "mcp-session-id": `fake-session-${sessionCounter}` })
          .end(JSON.stringify(reply));
        return;
      }
      // Non-initialize replies use an SSE stream with a leading notification
      // so the client must match by id.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`: keepalive\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } })}\n\n`);
      response.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      return;
    }

    if (url.pathname === "/sse" && request.method === "GET") {
      const sessionId = `legacy-${++sessionCounter}`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`event: endpoint\ndata: ${options.legacyEndpoint ?? `/messages?sessionId=${sessionId}`}\n\n`);
      legacyStreams.set(sessionId, response);
      request.on("close", () => legacyStreams.delete(sessionId));
      return;
    }

    if (url.pathname === "/messages" && request.method === "POST") {
      const stream = legacyStreams.get(url.searchParams.get("sessionId") ?? "");
      if (!stream || !message) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(202).end("Accepted");
      if ("id" in message) {
        stream.write(`event: message\ndata: ${JSON.stringify(handleRpc(message))}\r\n\r\n`);
      }
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    streamableUrl: `${origin}/mcp`,
    sseUrl: `${origin}/sse`,
    requests,
    close: async () => {
      for (const stream of legacyStreams.values()) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
