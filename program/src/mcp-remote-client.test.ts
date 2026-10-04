import { afterEach, describe, expect, it } from "vitest";

import { callMcpTool, listMcpTools, McpRemoteError } from "./mcp-remote-client.js";
import {
  assertMcpUrlAllowed,
  checkMcpUrlSyntax,
  isForbiddenMcpAddress,
  McpUrlPolicyError,
} from "./mcp-url-policy.js";
import { startFakeMcpServer } from "./testing/fake-mcp-server.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function reasonOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof McpUrlPolicyError) return error.reason;
    throw error;
  }
  return "allowed";
}

describe("MCP URL policy", () => {
  it.each([
    ["https://mcp.example.com/mcp", "allowed"],
    ["https://my-box.tailnet-1234.ts.net/mcp", "allowed"],
    ["https://100.101.102.103/mcp", "allowed"],
    ["https://8.8.8.8/mcp", "allowed"],
    ["http://mcp.example.com/mcp", "scheme_not_https"],
    ["ftp://mcp.example.com/", "scheme_not_https"],
    ["https://user:pass@mcp.example.com/", "userinfo_not_allowed"],
    ["https://mcp.example.com/mcp#frag", "fragment_not_allowed"],
    ["https://mcp.example.com/mcp?api_key=secret", "query_not_allowed"],
    ["https://localhost/mcp", "hostname_not_allowed"],
    ["https://api.localhost/mcp", "hostname_not_allowed"],
    ["https://printer.local/mcp", "hostname_not_allowed"],
    ["https://metadata.google.internal/", "hostname_not_allowed"],
    ["https://intranet/mcp", "hostname_not_allowed"],
    ["https://127.0.0.1/mcp", "address_not_allowed"],
    ["https://10.0.0.5/mcp", "address_not_allowed"],
    ["https://172.16.4.1/mcp", "address_not_allowed"],
    ["https://192.168.1.10/mcp", "address_not_allowed"],
    ["https://169.254.169.254/latest/meta-data", "address_not_allowed"],
    ["https://0.0.0.0/", "address_not_allowed"],
    ["https://224.0.0.1/", "address_not_allowed"],
    ["https://[::1]/mcp", "address_not_allowed"],
    ["https://[::]/mcp", "address_not_allowed"],
    ["https://[fd12:3456::1]/mcp", "address_not_allowed"],
    ["https://[fe80::1]/mcp", "address_not_allowed"],
    ["https://[ff02::1]/mcp", "address_not_allowed"],
    ["https://[::ffff:127.0.0.1]/mcp", "address_not_allowed"],
    ["https://[::ffff:a9fe:a9fe]/mcp", "address_not_allowed"],
    ["https://[2606:4700::1111]/mcp", "allowed"],
    ["not a url", "invalid_url"],
  ])("%s → %s", (url, expected) => {
    expect(reasonOf(() => checkMcpUrlSyntax(url, {}))).toBe(expected);
  });

  it("classifies raw resolved addresses", () => {
    expect(isForbiddenMcpAddress("100.64.0.1")).toBe(false);
    expect(isForbiddenMcpAddress("100.127.255.254")).toBe(false);
    expect(isForbiddenMcpAddress("93.184.216.34")).toBe(false);
    expect(isForbiddenMcpAddress("172.31.255.255")).toBe(true);
    expect(isForbiddenMcpAddress("172.32.0.1")).toBe(false);
    expect(isForbiddenMcpAddress("64:ff9b::a00:1")).toBe(true);
    expect(isForbiddenMcpAddress("not-an-ip")).toBe(true);
  });

  it("allows exact allowlisted origins (including http) and nothing else on that host", () => {
    const env = { MARKETPLACE_MCP_ALLOWED_ORIGINS: "http://127.0.0.1:9000, https://fixture.test" };
    expect(checkMcpUrlSyntax("http://127.0.0.1:9000/mcp", env).allowlisted).toBe(true);
    expect(reasonOf(() => checkMcpUrlSyntax("http://127.0.0.1:9001/mcp", env))).toBe("scheme_not_https");
    expect(reasonOf(() => checkMcpUrlSyntax("http://u:p@127.0.0.1:9000/mcp", env))).toBe("userinfo_not_allowed");
  });

  it("re-checks every DNS answer before connecting", async () => {
    const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const rebinding = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.1.2.3", family: 4 },
    ];
    const metadata = async () => [{ address: "169.254.169.254", family: 4 }];
    const tailnet = async () => [{ address: "100.88.1.2", family: 4 }];
    const failing = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertMcpUrlAllowed("https://mcp.example.com/mcp", { env: {}, lookup: publicLookup })).resolves.toBeInstanceOf(URL);
    await expect(assertMcpUrlAllowed("https://box.example.ts.net/mcp", { env: {}, lookup: tailnet })).resolves.toBeInstanceOf(URL);
    await expect(assertMcpUrlAllowed("https://mcp.example.com/mcp", { env: {}, lookup: rebinding })).rejects.toMatchObject({ reason: "address_not_allowed" });
    await expect(assertMcpUrlAllowed("https://mcp.example.com/mcp", { env: {}, lookup: metadata })).rejects.toMatchObject({ reason: "address_not_allowed" });
    await expect(assertMcpUrlAllowed("https://mcp.example.com/mcp", { env: {}, lookup: failing })).rejects.toMatchObject({ reason: "dns_lookup_failed" });
  });
});

describe("remote MCP client", () => {
  it("lists tools over streamable HTTP with session and protocol headers, then closes the session", async () => {
    const server = await startFakeMcpServer({ requiredHeader: { name: "x-api-key", value: "fixture-secret" } });
    servers.push(server);
    const env = { MARKETPLACE_MCP_ALLOWED_ORIGINS: server.origin };
    const tools = await listMcpTools({
      url: server.streamableUrl,
      transport: "streamable-http",
      headers: { "x-api-key": "fixture-secret", "x-team": "blue" },
      env,
    });
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "create_issue", "Delete Everything!", "fail_tool"]);
    expect(tools[0]).toMatchObject({ title: "Echo", annotations: { readOnlyHint: true } });
    const rpc = server.requests.filter((request) => request.path === "/mcp");
    expect(rpc.map((request) => request.rpcMethod ?? request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
      "DELETE",
    ]);
    expect(rpc[0]!.headers["mcp-session-id"]).toBeUndefined();
    expect(rpc[0]!.headers.accept).toBe("application/json, text/event-stream");
    for (const request of rpc.slice(1)) {
      expect(request.headers["mcp-session-id"]).toBe("fake-session-1");
      expect(request.headers["mcp-protocol-version"]).toBe("2025-06-18");
      expect(request.headers["x-team"]).toBe("blue");
    }
  });

  it("calls tools over streamable HTTP and reports isError without throwing", async () => {
    const server = await startFakeMcpServer();
    servers.push(server);
    const options = { url: server.streamableUrl, transport: "streamable-http" as const, env: { MARKETPLACE_MCP_ALLOWED_ORIGINS: server.origin } };
    const result = await callMcpTool(options, "echo", { message: "hi" });
    expect(result).toEqual({
      isError: false,
      content: [{ type: "text", text: '{"message":"hi"}' }],
      structuredContent: { tool: "echo", arguments: { message: "hi" } },
    });
    expect((await callMcpTool(options, "fail_tool", {})).isError).toBe(true);
    await expect(callMcpTool(options, "missing", {})).rejects.toMatchObject({ code: "mcp_rpc_error", detail: { rpcCode: -32602 } });
  });

  it("speaks the legacy SSE transport and matches replies by id", async () => {
    const server = await startFakeMcpServer({ requiredHeader: { name: "authorization", value: "Bearer legacy" } });
    servers.push(server);
    const options = {
      url: server.sseUrl,
      transport: "sse" as const,
      headers: { authorization: "Bearer legacy" },
      env: { MARKETPLACE_MCP_ALLOWED_ORIGINS: server.origin },
    };
    const tools = await listMcpTools(options);
    expect(tools).toHaveLength(4);
    const result = await callMcpTool(options, "echo", { n: 1 });
    expect(result.structuredContent).toEqual({ tool: "echo", arguments: { n: 1 } });
    const posts = server.requests.filter((request) => request.path === "/messages");
    expect(posts.every((request) => request.headers.authorization === "Bearer legacy")).toBe(true);
  });

  it("refuses a cross-origin legacy SSE endpoint", async () => {
    const server = await startFakeMcpServer({ legacyEndpoint: "https://attacker.example/messages" });
    servers.push(server);
    await expect(
      listMcpTools({ url: server.sseUrl, transport: "sse", env: { MARKETPLACE_MCP_ALLOWED_ORIGINS: server.origin } }),
    ).rejects.toMatchObject({ code: "mcp_protocol_error" });
  });

  it("maps auth failures, policy violations, unreachable hosts, and oversized bodies", async () => {
    const server = await startFakeMcpServer({ requiredHeader: { name: "x-api-key", value: "right" } });
    servers.push(server);
    const env = { MARKETPLACE_MCP_ALLOWED_ORIGINS: server.origin };
    const rejected = listMcpTools({ url: server.streamableUrl, transport: "streamable-http", headers: { "x-api-key": "wrong" }, env });
    await expect(rejected).rejects.toMatchObject({ code: "mcp_auth_rejected", detail: { status: 401 } });
    await rejected.catch((error: Error) => expect(error.message).not.toContain("wrong"));

    await expect(listMcpTools({ url: server.streamableUrl, transport: "streamable-http", env: {} })).rejects.toMatchObject({ code: "custom_mcp_url_not_allowed" });
    await expect(listMcpTools({ url: "http://127.0.0.1:1/mcp", transport: "streamable-http", env: { MARKETPLACE_MCP_ALLOWED_ORIGINS: "http://127.0.0.1:1" } })).rejects.toMatchObject({ code: "mcp_unreachable" });

    const huge = async () => new Response("x".repeat(64), { status: 200, headers: { "content-type": "application/json" } });
    await expect(
      listMcpTools({ url: "https://mcp.example.com/mcp", transport: "streamable-http", env: {}, lookup: async () => [{ address: "93.184.216.34", family: 4 }], fetchImpl: huge, maxBodyBytes: 16 }),
    ).rejects.toMatchObject({ code: "mcp_response_too_large" });
  });

  it("refuses redirects and times out slow servers", async () => {
    const calls: RequestInit[] = [];
    const slow: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    };
    const error = await listMcpTools({
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      env: {},
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: slow,
      timeouts: { connectMs: 20 },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpRemoteError);
    expect(error).toMatchObject({ code: "mcp_timeout" });
    expect(calls[0]?.redirect).toBe("error");
  });
});
