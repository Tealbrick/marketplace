/**
 * Minimal remote MCP client (JSON-RPC 2.0) for operator custom connectors.
 *
 * Transports:
 * - streamable-http: POST each message with
 *   `Accept: application/json, text/event-stream`; the reply is either a JSON
 *   body or an SSE stream. `Mcp-Session-Id` is round-tripped and
 *   `MCP-Protocol-Version` is sent after initialization. The session is
 *   closed with a best-effort DELETE.
 * - sse (legacy 2024-11-05): GET an event stream, wait for the `endpoint`
 *   event (must be same-origin), POST messages there and match replies by id.
 *
 * Every connection re-runs the URL policy (including a fresh DNS check), uses
 * `redirect: "error"`, bounded timeouts, and a response size cap. Error
 * messages never include header values or upstream bodies.
 */
import {
  assertMcpUrlAllowed,
  McpUrlPolicyError,
  type McpLookup,
} from "./mcp-url-policy.js";
import { routeOutbound, tailnetAwareFetch, TailnetUnavailableError } from "./tailnet.js";
import { MARKETPLACE_VERSION } from "./version.js";

export type McpTransport = "streamable-http" | "sse";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_REQUEST_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 30_000;
export const MCP_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MCP_MAX_TOOLS = 200;
const MCP_MAX_TOOL_PAGES = 50;

export type McpRemoteErrorCode =
  | "mcp_unreachable"
  | "mcp_timeout"
  | "mcp_auth_rejected"
  | "mcp_http_error"
  | "mcp_protocol_error"
  | "mcp_response_too_large"
  | "mcp_rpc_error"
  | "custom_mcp_url_not_allowed"
  | "tailnet_unavailable";

export class McpRemoteError extends Error {
  constructor(
    readonly code: McpRemoteErrorCode,
    message: string,
    readonly detail: { status?: number; rpcCode?: number; reason?: string } = {},
  ) {
    super(message);
  }
}

export type McpConnectionOptions = {
  url: string;
  transport: McpTransport;
  /** Plain and secret headers, attached to every request. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  lookup?: McpLookup;
  env?: Record<string, string | undefined>;
  timeouts?: { connectMs?: number; requestMs?: number; callMs?: number };
  maxBodyBytes?: number;
};

export type McpRemoteTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

export type McpCallToolResult = {
  content: unknown[];
  structuredContent?: unknown;
  isError: boolean;
};

type JsonRpcId = number;
type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

interface McpTransportSession {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  setProtocolVersion(version: string): void;
  close(): Promise<void>;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function transportFailure(error: unknown, timedOut: boolean): McpRemoteError {
  if (error instanceof McpRemoteError) return error;
  if (timedOut || isAbortError(error)) {
    return new McpRemoteError("mcp_timeout", "The MCP server did not respond in time.");
  }
  return new McpRemoteError("mcp_unreachable", "The MCP server could not be reached.");
}

function statusFailure(status: number): McpRemoteError {
  if (status === 401 || status === 403) {
    return new McpRemoteError("mcp_auth_rejected", "The MCP server rejected the credentials.", { status });
  }
  return new McpRemoteError("mcp_http_error", `The MCP server answered HTTP ${status}.`, { status });
}

/** Incremental text/event-stream parser. */
class SseParser {
  private buffer = "";
  private eventName = "";
  private data: string[] = [];
  private dataBytes = 0;

  constructor(
    private readonly onEvent: (event: { event: string; data: string }) => void,
    private readonly maxEventBytes: number,
  ) {}

  feed(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const match = /\r\n|\r|\n/u.exec(this.buffer);
      if (!match) break;
      // A lone trailing CR may be the first half of CRLF split across chunks.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line);
    }
    if (this.buffer.length > this.maxEventBytes) {
      throw new McpRemoteError("mcp_response_too_large", "The MCP server response was too large.");
    }
  }

  private line(line: string) {
    if (line === "") {
      if (this.data.length > 0) {
        const event = { event: this.eventName || "message", data: this.data.join("\n") };
        this.eventName = "";
        this.data = [];
        this.dataBytes = 0;
        this.onEvent(event);
      } else {
        this.eventName = "";
      }
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    if (field === "data") {
      this.dataBytes += value.length;
      if (this.dataBytes > this.maxEventBytes) {
        throw new McpRemoteError("mcp_response_too_large", "The MCP server response was too large.");
      }
      this.data.push(value);
    }
  }
}

async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new McpRemoteError("mcp_response_too_large", "The MCP server response was too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function discardBody(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new McpRemoteError("mcp_protocol_error", "The MCP server sent an invalid JSON-RPC message.");
  }
}

function resultFromMessage(message: JsonRpcMessage): unknown {
  if (message.jsonrpc !== "2.0") {
    throw new McpRemoteError("mcp_protocol_error", "The MCP server sent an invalid JSON-RPC message.");
  }
  if (message.error) {
    const rpcCode = typeof message.error.code === "number" ? message.error.code : undefined;
    throw new McpRemoteError("mcp_rpc_error", "The MCP server returned a JSON-RPC error.", { rpcCode });
  }
  if (!("result" in message)) {
    throw new McpRemoteError("mcp_protocol_error", "The MCP server sent an invalid JSON-RPC message.");
  }
  return message.result;
}

function buildHeaders(
  base: Record<string, string> | undefined,
  protocol: Record<string, string>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(base ?? {})) headers.set(name, value);
  for (const [name, value] of Object.entries(protocol)) headers.set(name, value);
  return headers;
}

class StreamableHttpSession implements McpTransportSession {
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private nextId: JsonRpcId = 1;

  constructor(
    private readonly url: URL,
    private readonly options: McpConnectionOptions,
    private readonly fetchImpl: typeof fetch,
    private readonly maxBytes: number,
  ) {}

  setProtocolVersion(version: string) {
    this.protocolVersion = version;
  }

  private headers(extra: Record<string, string> = {}) {
    return buildHeaders(this.options.headers, {
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
      ...extra,
    });
  }

  private async post(message: Record<string, unknown>, timeoutMs: number, expectId: JsonRpcId | null) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(message),
        redirect: "error",
        signal: controller.signal,
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId && /^[\x21-\x7e]{1,256}$/u.test(sessionId)) this.sessionId = sessionId;
      if (!response.ok) {
        await discardBody(response);
        throw statusFailure(response.status);
      }
      if (expectId === null) {
        await discardBody(response);
        return undefined;
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/event-stream")) {
        return await this.readEventStreamReply(response, expectId);
      }
      const parsed = parseJson(await readCappedText(response, this.maxBytes));
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const reply = messages
        .map((entry) => recordValue(entry) as JsonRpcMessage | null)
        .find((entry) => entry?.id === expectId);
      if (!reply) {
        throw new McpRemoteError("mcp_protocol_error", "The MCP server did not answer the request.");
      }
      return resultFromMessage(reply);
    } catch (error) {
      throw transportFailure(error, timedOut);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readEventStreamReply(response: Response, expectId: JsonRpcId) {
    if (!response.body) {
      throw new McpRemoteError("mcp_protocol_error", "The MCP server did not answer the request.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let reply: JsonRpcMessage | null = null;
    const parser = new SseParser((event) => {
      if (reply || event.event !== "message") return;
      const message = recordValue(parseJson(event.data)) as JsonRpcMessage | null;
      if (message?.id === expectId && ("result" in message || "error" in message)) {
        reply = message;
      }
    }, this.maxBytes);
    try {
      while (!reply) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxBytes) {
          throw new McpRemoteError("mcp_response_too_large", "The MCP server response was too large.");
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (!reply) {
      throw new McpRemoteError("mcp_protocol_error", "The MCP server did not answer the request.");
    }
    return resultFromMessage(reply);
  }

  async request(method: string, params: unknown, timeoutMs: number) {
    const id = this.nextId++;
    return this.post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, timeoutMs, id);
  }

  async notify(method: string, params?: unknown) {
    await this.post(
      { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) },
      this.options.timeouts?.connectMs ?? MCP_CONNECT_TIMEOUT_MS,
      null,
    );
  }

  async close() {
    if (!this.sessionId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "DELETE",
        headers: this.headers(),
        redirect: "error",
        signal: controller.signal,
      });
      await discardBody(response);
    } catch {
      // Best effort: servers may not support explicit session termination.
    } finally {
      clearTimeout(timer);
      this.sessionId = null;
    }
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: McpRemoteError) => void;
  timer: ReturnType<typeof setTimeout>;
};

class LegacySseSession implements McpTransportSession {
  private readonly controller = new AbortController();
  private readonly pending = new Map<JsonRpcId, Pending>();
  private endpoint: URL | null = null;
  private failure: McpRemoteError | null = null;
  private nextId: JsonRpcId = 1;
  private endpointWaiter: { resolve: (url: URL) => void; reject: (error: McpRemoteError) => void } | null = null;

  constructor(
    private readonly url: URL,
    private readonly options: McpConnectionOptions,
    private readonly fetchImpl: typeof fetch,
    private readonly maxBytes: number,
  ) {}

  setProtocolVersion() {
    // The 2024-11-05 HTTP+SSE transport has no protocol-version header.
  }

  async open(timeoutMs: number) {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.fail(new McpRemoteError("mcp_timeout", "The MCP server did not respond in time."));
      this.controller.abort();
    }, timeoutMs);
    try {
      const endpoint = new Promise<URL>((resolve, reject) => {
        this.endpointWaiter = { resolve, reject };
      });
      endpoint.catch(() => undefined);
      const response = await this.fetchImpl(this.url, {
        method: "GET",
        headers: buildHeaders(this.options.headers, { accept: "text/event-stream" }),
        redirect: "error",
        signal: this.controller.signal,
      });
      if (!response.ok) {
        await discardBody(response);
        throw statusFailure(response.status);
      }
      if (!response.body) {
        throw new McpRemoteError("mcp_protocol_error", "The MCP server did not open an event stream.");
      }
      void this.pump(response.body);
      this.endpoint = await endpoint;
    } catch (error) {
      this.controller.abort();
      throw transportFailure(this.failure ?? error, timedOut);
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(error: McpRemoteError) {
    if (!this.failure) this.failure = error;
    this.endpointWaiter?.reject(this.failure);
    this.endpointWaiter = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
      this.pending.delete(id);
    }
  }

  private onEvent(event: { event: string; data: string }) {
    if (event.event === "endpoint") {
      if (this.endpoint || !this.endpointWaiter) return;
      let endpoint: URL;
      try {
        endpoint = new URL(event.data.trim(), this.url);
      } catch {
        throw new McpRemoteError("mcp_protocol_error", "The MCP server sent an invalid endpoint.");
      }
      if (endpoint.origin !== this.url.origin) {
        throw new McpRemoteError("mcp_protocol_error", "The MCP server endpoint must be on the same origin.");
      }
      this.endpointWaiter.resolve(endpoint);
      this.endpointWaiter = null;
      return;
    }
    if (event.event !== "message") return;
    const message = recordValue(parseJson(event.data)) as JsonRpcMessage | null;
    if (!message || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending || !("result" in message || "error" in message)) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    try {
      pending.resolve(resultFromMessage(message));
    } catch (error) {
      pending.reject(error as McpRemoteError);
    }
  }

  private async pump(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser((event) => this.onEvent(event), this.maxBytes);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      this.fail(new McpRemoteError("mcp_unreachable", "The MCP server closed the event stream."));
    } catch (error) {
      this.fail(transportFailure(error, false));
      this.controller.abort();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async send(message: Record<string, unknown>, timeoutMs: number) {
    if (this.failure) throw this.failure;
    if (!this.endpoint) {
      throw new McpRemoteError("mcp_protocol_error", "The MCP server did not announce an endpoint.");
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortOnClose = () => controller.abort();
    this.controller.signal.addEventListener("abort", abortOnClose, { once: true });
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: buildHeaders(this.options.headers, { "content-type": "application/json" }),
        body: JSON.stringify(message),
        redirect: "error",
        signal: controller.signal,
      });
      await discardBody(response);
      if (!response.ok) throw statusFailure(response.status);
    } catch (error) {
      throw transportFailure(error, timedOut);
    } finally {
      clearTimeout(timer);
      this.controller.signal.removeEventListener("abort", abortOnClose);
    }
  }

  async request(method: string, params: unknown, timeoutMs: number) {
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpRemoteError("mcp_timeout", "The MCP server did not respond in time."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    // Avoid an unhandled rejection if the POST itself fails first.
    reply.catch(() => undefined);
    try {
      await this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, timeoutMs);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      throw error;
    }
    return reply;
  }

  async notify(method: string, params?: unknown) {
    await this.send(
      { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) },
      this.options.timeouts?.connectMs ?? MCP_CONNECT_TIMEOUT_MS,
    );
  }

  async close() {
    this.controller.abort();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new McpRemoteError("mcp_unreachable", "The MCP session was closed."));
      this.pending.delete(id);
    }
  }
}

/** An initialized MCP session. Always `close()` it. */
export class McpRemoteClient {
  private constructor(
    private readonly session: McpTransportSession,
    private readonly options: McpConnectionOptions,
  ) {}

  static async connect(options: McpConnectionOptions): Promise<McpRemoteClient> {
    let url: URL;
    try {
      url = await assertMcpUrlAllowed(options.url, { env: options.env, lookup: options.lookup });
      routeOutbound(url, options.env);
    } catch (error) {
      if (error instanceof TailnetUnavailableError) {
        throw new McpRemoteError("tailnet_unavailable", error.message);
      }
      if (error instanceof McpUrlPolicyError) {
        throw new McpRemoteError("custom_mcp_url_not_allowed", error.message, { reason: error.reason });
      }
      throw error;
    }
    // Tailnet hosts go through the tailnet proxy when one is configured.
    const fetchImpl = tailnetAwareFetch(options.env, options.fetchImpl, options.lookup);
    const maxBytes = options.maxBodyBytes ?? MCP_MAX_BODY_BYTES;
    const connectMs = options.timeouts?.connectMs ?? MCP_CONNECT_TIMEOUT_MS;
    let session: McpTransportSession;
    if (options.transport === "sse") {
      const legacy = new LegacySseSession(url, options, fetchImpl, maxBytes);
      await legacy.open(connectMs);
      session = legacy;
    } else {
      session = new StreamableHttpSession(url, options, fetchImpl, maxBytes);
    }
    try {
      const initialized = recordValue(
        await session.request(
          "initialize",
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "tealbrick-marketplace", version: MARKETPLACE_VERSION },
          },
          connectMs,
        ),
      );
      const protocolVersion = initialized?.protocolVersion;
      if (typeof protocolVersion !== "string" || !/^[\w.-]{1,32}$/u.test(protocolVersion)) {
        throw new McpRemoteError("mcp_protocol_error", "The MCP server sent an invalid initialize result.");
      }
      session.setProtocolVersion(protocolVersion);
      await session.notify("notifications/initialized");
      return new McpRemoteClient(session, options);
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async listTools(maxTools = MCP_MAX_TOOLS): Promise<McpRemoteTool[]> {
    const tools: McpRemoteTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MCP_MAX_TOOL_PAGES && tools.length < maxTools; page += 1) {
      const result = recordValue(
        await this.session.request(
          "tools/list",
          cursor ? { cursor } : {},
          this.options.timeouts?.requestMs ?? MCP_REQUEST_TIMEOUT_MS,
        ),
      );
      if (!result || !Array.isArray(result.tools)) {
        throw new McpRemoteError("mcp_protocol_error", "The MCP server sent an invalid tools/list result.");
      }
      for (const entry of result.tools) {
        const tool = recordValue(entry);
        if (!tool || typeof tool.name !== "string" || !tool.name.trim()) continue;
        tools.push({
          name: tool.name,
          ...(typeof tool.title === "string" ? { title: tool.title } : {}),
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...("inputSchema" in tool ? { inputSchema: tool.inputSchema } : {}),
          ...(recordValue(tool.annotations) ? { annotations: recordValue(tool.annotations)! } : {}),
        });
        if (tools.length >= maxTools) break;
      }
      const next = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    const result = recordValue(
      await this.session.request(
        "tools/call",
        { name, arguments: args },
        this.options.timeouts?.callMs ?? MCP_CALL_TIMEOUT_MS,
      ),
    );
    if (!result) {
      throw new McpRemoteError("mcp_protocol_error", "The MCP server sent an invalid tools/call result.");
    }
    return {
      content: Array.isArray(result.content) ? result.content : [],
      ...("structuredContent" in result ? { structuredContent: result.structuredContent } : {}),
      isError: result.isError === true,
    };
  }

  async close() {
    await this.session.close();
  }
}

export async function listMcpTools(options: McpConnectionOptions, maxTools = MCP_MAX_TOOLS) {
  const client = await McpRemoteClient.connect(options);
  try {
    return await client.listTools(maxTools);
  } finally {
    await client.close();
  }
}

export async function callMcpTool(
  options: McpConnectionOptions,
  name: string,
  args: Record<string, unknown>,
) {
  const client = await McpRemoteClient.connect(options);
  try {
    return await client.callTool(name, args);
  } finally {
    await client.close();
  }
}
