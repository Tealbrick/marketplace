/**
 * Company Box REST executor: one HTTP call for one OpenAPI operation.
 *
 * - The base URL re-runs the outbound URL policy (fresh DNS) on every call;
 *   tailnet addresses (100.64/10, *.ts.net) are allowed, private and
 *   metadata ranges are not.
 * - `redirect: "error"`; the final URL must keep the base origin and path
 *   prefix (path parameters are encoded and `.`/`..` are refused).
 * - Bounded timeout and response size; JSON, text and binary (base64,
 *   separately capped) responses.
 * - Only declared header parameters are sent; transport and hop-by-hop
 *   headers and the credential header cannot be supplied by the caller.
 * - Credentials come from the connector secret store and are attached here
 *   only. Error messages carry codes and statuses, never URLs with
 *   credentials, header values or upstream bodies; response text is scrubbed
 *   of every credential value before it is returned.
 */
import { assertMcpUrlAllowed, McpUrlPolicyError, type McpLookup } from "./mcp-url-policy.js";
import { routeOutbound, tailnetAwareFetch, TailnetUnavailableError } from "./tailnet.js";
import { parameterDefault, type OpenApiOperation, type OpenApiParameter } from "./openapi-adapter.js";
import type { ArgumentValidator } from "./openapi-validate.js";
import { MARKETPLACE_VERSION } from "./version.js";

export const OPENAPI_CALL_TIMEOUT_MS = 30_000;
export const OPENAPI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const OPENAPI_MAX_BINARY_BYTES = 512 * 1024;
/** Decoded upload cap per request (sum of all files); MARKETPLACE_COMPANY_BOX_MAX_UPLOAD_BYTES overrides. */
export const OPENAPI_DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function companyBoxMaxUploadBytes(env: Record<string, string | undefined> = process.env) {
  const value = Number(env.MARKETPLACE_COMPANY_BOX_MAX_UPLOAD_BYTES);
  return Number.isInteger(value) && value > 0 ? value : OPENAPI_DEFAULT_MAX_UPLOAD_BYTES;
}
const MAX_ERROR_BODY_CHARS = 4_096;

export type OpenApiAuth =
  | { type: "none" }
  | { type: "header"; name: string; prefix?: string }
  | { type: "basic" }
  | { type: "query"; name: string };

/** Decrypted credential values keyed by credential field (token, username, …). */
export type OpenApiCredentials = Record<string, string>;

export type OpenApiErrorCode =
  | "openapi_base_url_not_allowed"
  | "openapi_argument_invalid"
  | "openapi_credentials_missing"
  | "openapi_unreachable"
  | "openapi_timeout"
  | "openapi_auth_rejected"
  | "openapi_http_error"
  | "openapi_response_too_large"
  | "openapi_upload_too_large"
  | "tailnet_unavailable";

export class OpenApiCallError extends Error {
  constructor(
    readonly code: OpenApiErrorCode,
    message: string,
    readonly detail: {
      status?: number;
      reason?: string;
      field?: string;
      /** Scrubbed, bounded upstream error body (4xx/5xx) for the agent to correct its call. */
      body?: unknown;
    } = {},
  ) {
    super(message);
  }
}

export type OpenApiCallResult = {
  status: number;
  contentType: string | null;
  bodyKind: "json" | "text" | "binary" | "empty";
  body?: unknown;
  text?: string;
  base64?: string;
  bytes: number;
  headers: Record<string, string>;
};

export type OpenApiCallOptions = {
  baseUrl: string;
  /** Spec base path (Swagger basePath / server path), joined after the base URL path. */
  apiBasePath?: string;
  operation: Pick<OpenApiOperation, "method" | "path" | "parameters" | "requestBody">;
  args: Record<string, unknown>;
  auth: OpenApiAuth;
  credentials: OpenApiCredentials;
  fetchImpl?: typeof fetch;
  lookup?: McpLookup;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxBinaryBytes?: number;
  /** Schema validator for the operation's arguments (run before any request is built). */
  validateArguments?: ArgumentValidator;
  /** Decoded upload cap for this request (default 25 MB). */
  maxUploadBytes?: number;
};

const FORBIDDEN_HEADER_NAMES = new Set([
  "accept-encoding",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Response headers worth returning to an agent (pagination, caching, ids). */
const RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "etag",
  "last-modified",
  "link",
  "x-total-count",
  "x-total",
  "x-page",
  "x-per-page",
  "x-next-page",
  "x-request-id",
  "retry-after",
]);

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function argumentError(field: string, reason: string): never {
  throw new OpenApiCallError("openapi_argument_invalid", `Argument ${field} is invalid (${reason}).`, {
    field,
    reason,
  });
}

function scalarString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return argumentError(field, "expected a string, number or boolean");
}

function headerValueValid(value: string) {
  return value.length <= 4_096 && /^[\t\x20-\x7e\x80-\xff]*$/u.test(value);
}

/** Secret credential values to scrub from responses (not the basic-auth username). */
export function credentialValues(credentials: OpenApiCredentials, auth: OpenApiAuth) {
  const values = Object.entries(credentials)
    .filter(([field, value]) => field !== "username" && value.length >= 4)
    .map(([, value]) => value);
  if (auth.type === "basic" && credentials.username !== undefined && credentials.password !== undefined) {
    values.push(Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64"));
  }
  return values;
}

/**
 * Every form a credential can take in a response: raw, URL-encoded (both
 * encoders, `+` for spaces), JSON-escaped (with and without `\/`), and
 * base64 / base64url.
 */
export function secretVariants(secret: string) {
  const json = JSON.stringify(secret).slice(1, -1);
  const forms = new Set([
    secret,
    encodeURIComponent(secret),
    encodeURI(secret),
    encodeURIComponent(secret).replace(/%20/gu, "+"),
    json,
    json.replace(/\//gu, "\\/"),
    secret.replace(/\//gu, "\\/"),
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
    Buffer.from(secret).toString("base64").replace(/=+$/u, ""),
  ]);
  // Lower-case hex escapes from some encoders.
  forms.add(encodeURIComponent(secret).replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()));
  return [...forms].filter((form) => form.length >= 4).sort((left, right) => right.length - left.length);
}

/** Replace every credential value in `text`, in every encoding it may appear in. */
export function scrubSecrets(text: string, secrets: readonly string[]) {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of secretVariants(secret)) {
      out = out.split(form).join("[redacted]");
    }
  }
  return out;
}

export function scrubDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, secrets));
  const record = recordValue(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [scrubSecrets(key, secrets), scrubDeep(child, secrets)]),
  );
}

function groupArgs(args: Record<string, unknown>, group: string): Record<string, unknown> {
  const value = args[group];
  if (value === undefined || value === null) return {};
  const record = recordValue(value);
  if (!record) argumentError(group, "expected an object");
  return record;
}

function declared(parameters: readonly OpenApiParameter[], location: OpenApiParameter["in"]) {
  return new Map(
    parameters.filter((parameter) => parameter.in === location).map((parameter) => [parameter.name, parameter]),
  );
}

function checkUnknown(group: string, supplied: Record<string, unknown>, known: Map<string, unknown>) {
  for (const name of Object.keys(supplied)) {
    if (!known.has(name)) argumentError(`${group}.${name}`, "not declared by the operation");
  }
}

/**
 * Names that can re-target a request on common frameworks (method override)
 * or smuggle a second API key; refused wherever a caller can set a name.
 */
export function reservedParameterName(name: string, auth: OpenApiAuth) {
  const lower = name.toLowerCase();
  return (
    lower === "_method" ||
    lower.startsWith("x-http-method") ||
    lower.startsWith("x-method-override") ||
    (auth.type === "query" && lower === auth.name.toLowerCase())
  );
}

function appendQuery(search: URLSearchParams, parameter: OpenApiParameter, value: unknown, auth: OpenApiAuth) {
  const field = `query.${parameter.name}`;
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    const items = value.map((item) => scalarString(item, field));
    if (parameter.explode === false) search.append(parameter.name, items.join(","));
    else for (const item of items) search.append(parameter.name, item);
    return;
  }
  const record = recordValue(value);
  if (record) {
    // Objects explode only for object-typed parameters, and only into keys
    // the schema declares.
    const properties = recordValue(parameter.schema.properties);
    if (parameter.schema.type !== "object" || !properties) argumentError(field, "expected a scalar or array");
    for (const key of Object.keys(record)) {
      if (!(key in properties)) argumentError(`${field}.${key}`, "not declared by the operation");
      if (reservedParameterName(key, auth)) argumentError(`${field}.${key}`, "reserved parameter name");
    }
    if (parameter.style === "deepObject") {
      for (const [key, child] of Object.entries(record)) {
        search.append(`${parameter.name}[${key}]`, scalarString(child, field));
      }
    } else if (parameter.explode === false) {
      search.append(
        parameter.name,
        Object.entries(record)
          .flatMap(([key, child]) => [key, scalarString(child, field)])
          .join(","),
      );
    } else {
      for (const [key, child] of Object.entries(record)) search.append(key, scalarString(child, field));
    }
    return;
  }
  search.append(parameter.name, scalarString(value, field));
}

type FileArgument = { base64: string; filename?: unknown; contentType?: unknown };

function fileArgument(value: unknown): FileArgument | null {
  const record = recordValue(value);
  return record && typeof record.base64 === "string" ? (record as FileArgument) : null;
}

/** Decode one file, enforcing strict base64 and the running upload budget. */
function decodeFile(file: FileArgument, field: string, budget: { remaining: number; max: number }) {
  const text = file.base64.replace(/\s+/gu, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/u.test(text) || text.length % 4 === 1) {
    argumentError(`${field}.base64`, "not valid base64");
  }
  // Check the size from the encoded length before allocating.
  const estimated = Math.floor((text.length * 3) / 4);
  if (estimated - 2 > budget.remaining) {
    throw new OpenApiCallError(
      "openapi_upload_too_large",
      `Uploads are limited to ${budget.max} bytes per call.`,
      { field, reason: `limit ${budget.max} bytes` },
    );
  }
  const bytes = new Uint8Array(Buffer.from(text, text.includes("-") || text.includes("_") ? "base64url" : "base64"));
  if (bytes.byteLength > budget.remaining) {
    throw new OpenApiCallError("openapi_upload_too_large", `Uploads are limited to ${budget.max} bytes per call.`, {
      field,
      reason: `limit ${budget.max} bytes`,
    });
  }
  budget.remaining -= bytes.byteLength;
  return bytes;
}

function buildBody(
  operation: OpenApiCallOptions["operation"],
  value: unknown,
  maxUploadBytes = OPENAPI_DEFAULT_MAX_UPLOAD_BYTES,
): { body?: string | Uint8Array<ArrayBuffer> | FormData; contentType?: string } {
  const budget = { remaining: maxUploadBytes, max: maxUploadBytes };
  const requestBody = operation.requestBody;
  if (value === undefined) {
    if (requestBody?.required) argumentError("body", "required");
    return {};
  }
  if (!requestBody) argumentError("body", "the operation takes no request body");
  const contentType = requestBody.contentType;
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  if (base === "application/json" || base.endsWith("+json") || base.endsWith("/json")) {
    return { body: JSON.stringify(value), contentType };
  }
  if (base === "application/x-www-form-urlencoded") {
    const record = recordValue(value) ?? argumentError("body", "expected an object");
    const form = new URLSearchParams();
    for (const [key, child] of Object.entries(record)) {
      if (Array.isArray(child)) for (const item of child) form.append(key, scalarString(item, `body.${key}`));
      else if (child !== undefined && child !== null) form.append(key, scalarString(child, `body.${key}`));
    }
    return { body: form.toString(), contentType };
  }
  if (base === "multipart/form-data") {
    const record = recordValue(value) ?? argumentError("body", "expected an object");
    const form = new FormData();
    const appendPart = (key: string, child: unknown, field: string) => {
      const file = fileArgument(child);
      if (file) {
        const bytes = decodeFile(file, field, budget);
        form.append(
          key,
          new Blob([bytes], {
            type: typeof file.contentType === "string" && file.contentType ? file.contentType : "application/octet-stream",
          }),
          typeof file.filename === "string" && file.filename ? file.filename : key,
        );
      } else if (child !== undefined && child !== null) {
        form.append(key, typeof child === "object" ? JSON.stringify(child) : scalarString(child, field));
      }
    };
    for (const [key, child] of Object.entries(record)) {
      // Arrays of files (or scalars) repeat the part name.
      if (Array.isArray(child) && child.some((item) => fileArgument(item))) {
        child.forEach((item, index) => appendPart(key, item, `body.${key}.${index}`));
      } else {
        appendPart(key, child, `body.${key}`);
      }
    }
    // fetch sets the multipart boundary itself.
    return { body: form };
  }
  if (base.startsWith("text/") || base === "application/xml") {
    return { body: scalarString(value, "body"), contentType };
  }
  const file = fileArgument(value);
  if (file) {
    return { body: decodeFile(file, "body", budget), contentType };
  }
  if (typeof value === "string") return { body: value, contentType };
  return { body: JSON.stringify(value), contentType };
}

/** One path segment: no separators (raw or percent-encoded), no dot segments. */
function validSegment(text: string) {
  const decodedDots = text.replace(/%2e/giu, ".");
  return !(
    text === "" ||
    /[/\\]/u.test(text) ||
    /%(2f|5c)/iu.test(text) ||
    decodedDots === "." ||
    decodedDots === ".."
  );
}

/**
 * Encode one path argument. Normal parameters are a single segment;
 * `x-multi-segment` ones may span `/` (one leading/trailing slash is
 * ignored), and every segment is checked and percent-encoded on its own.
 */
export function renderPathValue(text: string, field: string, multiSegment: boolean) {
  if (!multiSegment) {
    if (!validSegment(text)) argumentError(field, "not a valid path segment");
    return encodeURIComponent(text);
  }
  const segments = text.replace(/^\//u, "").replace(/\/$/u, "").split("/");
  if (!segments.every(validSegment)) argumentError(field, "not a valid path");
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function renderPathTemplate(template: string, value: (name: string) => string) {
  return template.replace(/\{([^}]+)\}/gu, (_match, name: string) => value(name));
}

/** Build the outbound request without sending it. Exported for tests. */
export function buildOpenApiRequest(options: Omit<OpenApiCallOptions, "fetchImpl" | "lookup">, base: URL) {
  const { operation, args, auth, credentials } = options;
  for (const key of Object.keys(args)) {
    if (!["path", "query", "header", "body"].includes(key)) {
      argumentError(key, "arguments are grouped as path, query, header and body");
    }
  }
  if (options.validateArguments) {
    const validation = options.validateArguments(args);
    if (!validation.ok) argumentError(validation.field, validation.reason);
  }
  const pathArgs = groupArgs(args, "path");
  const queryArgs = groupArgs(args, "query");
  const headerArgs = groupArgs(args, "header");
  const pathParams = declared(operation.parameters, "path");
  const queryParams = declared(operation.parameters, "query");
  const headerParams = declared(operation.parameters, "header");
  checkUnknown("path", pathArgs, pathParams);
  checkUnknown("query", queryArgs, queryParams);
  checkUnknown("header", headerArgs, headerParams);
  for (const [group, supplied] of [["query", queryArgs], ["header", headerArgs], ["path", pathArgs]] as const) {
    for (const name of Object.keys(supplied)) {
      if (reservedParameterName(name, auth)) argumentError(`${group}.${name}`, "reserved parameter name");
    }
  }

  const renderedPath = renderPathTemplate(operation.path, (name) => {
    const value = pathArgs[name];
    if (value === undefined || value === null) argumentError(`path.${name}`, "required");
    return renderPathValue(scalarString(value, `path.${name}`), `path.${name}`, pathParams.get(name)?.multiSegment === true);
  });
  const prefix = base.pathname.replace(/\/+$/u, "");
  const apiBase = (options.apiBasePath ?? "").replace(/\/+$/u, "");
  const url = new URL(base.origin);
  url.pathname = `${prefix}${apiBase}${renderedPath.startsWith("/") ? "" : "/"}${renderedPath}`;
  if (url.origin !== base.origin || !url.pathname.startsWith(`${prefix}${apiBase}`)) {
    argumentError("path", "the request left the configured base URL");
  }
  for (const [name, parameter] of queryParams) {
    if (parameter.required && (queryArgs[name] === undefined || queryArgs[name] === null)) {
      argumentError(`query.${name}`, "required");
    }
    appendQuery(url.searchParams, parameter, queryArgs[name], auth);
  }

  const headers = new Headers();
  headers.set("accept", "application/json, text/plain;q=0.9, */*;q=0.8");
  headers.set("user-agent", `TealBrick-Marketplace/${MARKETPLACE_VERSION}`);
  const authHeaderName = auth.type === "header" ? auth.name.toLowerCase() : auth.type === "basic" ? "authorization" : null;
  for (const [name, parameter] of headerParams) {
    // Omitted headers with a default or const (e.g. OCS-APIRequest: true) are sent anyway.
    const value = headerArgs[name] ?? parameterDefault(parameter);
    if (value === undefined || value === null) {
      if (parameter.required) argumentError(`header.${name}`, "required");
      continue;
    }
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADER_NAMES.has(lower) || lower.startsWith("proxy-") || lower === authHeaderName) {
      argumentError(`header.${name}`, "reserved header");
    }
    const text = scalarString(value, `header.${name}`);
    if (!headerValueValid(text)) argumentError(`header.${name}`, "invalid header value");
    if (lower === "overwrite" && text !== "T" && text !== "F") argumentError(`header.${name}`, "must be T or F");
    if (lower === "depth" && !["0", "1", "infinity"].includes(text)) argumentError(`header.${name}`, "must be 0, 1 or infinity");
    if (lower === "destination") {
      // Never a caller-supplied URL: the base origin + prefix + the spec's
      // template, with the caller's value as a relative multi-segment path.
      if (!parameter.destinationTemplate) argumentError(`header.${name}`, "reserved header");
      const rendered = renderPathTemplate(parameter.destinationTemplate, (placeholder) => {
        if (placeholder.toLowerCase() === "destination" || placeholder === name) {
          return renderPathValue(text, `header.${name}`, true);
        }
        const pathValue = pathArgs[placeholder];
        if (pathValue === undefined || pathValue === null) argumentError(`path.${placeholder}`, "required");
        return renderPathValue(
          scalarString(pathValue, `path.${placeholder}`),
          `path.${placeholder}`,
          pathParams.get(placeholder)?.multiSegment === true,
        );
      });
      const destination = new URL(base.origin);
      destination.pathname = `${prefix}${apiBase}${rendered.startsWith("/") ? "" : "/"}${rendered}`;
      if (destination.origin !== base.origin || !destination.pathname.startsWith(`${prefix}${apiBase}/`)) {
        argumentError(`header.${name}`, "the destination left the configured base URL");
      }
      headers.set(lower, destination.toString());
      continue;
    }
    headers.set(lower, text);
  }

  if (auth.type === "header") {
    const token = credentials.token;
    if (!token) throw new OpenApiCallError("openapi_credentials_missing", "The connector has no API token configured.");
    headers.set(auth.name.toLowerCase(), `${auth.prefix ?? ""}${token}`);
  } else if (auth.type === "basic") {
    if (credentials.username === undefined || credentials.password === undefined) {
      throw new OpenApiCallError("openapi_credentials_missing", "The connector has no username and password configured.");
    }
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
    );
  } else if (auth.type === "query") {
    const key = credentials.apiKey;
    if (!key) throw new OpenApiCallError("openapi_credentials_missing", "The connector has no API key configured.");
    for (const name of queryParams.keys()) {
      if (name.toLowerCase() === auth.name.toLowerCase() && queryArgs[name] !== undefined) {
        argumentError(`query.${name}`, "reserved for the API key");
      }
    }
    url.searchParams.set(auth.name, key);
  }

  const { body, contentType } = buildBody(operation, args.body, options.maxUploadBytes);
  if (contentType) headers.set("content-type", contentType);
  return { url, method: operation.method.toUpperCase(), headers, body };
}

/**
 * Check arguments against the operation without contacting the app (throws
 * OpenApiCallError `openapi_argument_invalid`). Used before reserving
 * idempotent runtime operations.
 */
export function validateOpenApiArguments(
  operation: OpenApiCallOptions["operation"],
  args: Record<string, unknown>,
  auth: OpenApiAuth,
  validateArguments?: ArgumentValidator,
  maxUploadBytes?: number,
) {
  buildOpenApiRequest(
    {
      baseUrl: "https://validation.invalid",
      operation,
      args,
      auth,
      ...(validateArguments ? { validateArguments } : {}),
      ...(maxUploadBytes ? { maxUploadBytes } : {}),
      credentials: { token: "validation", username: "validation", password: "validation", apiKey: "validation" },
    },
    new URL("https://validation.invalid"),
  );
}

function isAbort(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new OpenApiCallError("openapi_response_too_large", "The app's response was too large.", {
      status: response.status,
    });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new OpenApiCallError("openapi_response_too_large", "The app's response was too large.", {
        status: response.status,
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function textual(contentType: string | null) {
  if (!contentType) return true;
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  return (
    base.startsWith("text/") ||
    base.endsWith("/json") ||
    base.endsWith("+json") ||
    base.endsWith("/xml") ||
    base.endsWith("+xml") ||
    base === "application/javascript" ||
    base === "application/x-www-form-urlencoded" ||
    base === "application/yaml" ||
    base === "application/x-yaml"
  );
}

function decodeResponse(
  bytes: Buffer,
  contentType: string | null,
  secrets: readonly string[],
  maxBinaryBytes: number,
  status: number,
): Pick<OpenApiCallResult, "bodyKind" | "body" | "text" | "base64"> {
  if (bytes.length === 0) return { bodyKind: "empty" };
  if (textual(contentType)) {
    const text = scrubSecrets(bytes.toString("utf8"), secrets);
    const base = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
    if (!contentType || base.endsWith("json")) {
      try {
        return { bodyKind: "json", body: JSON.parse(text) };
      } catch {
        // Fall through: report as text.
      }
    }
    return { bodyKind: "text", text };
  }
  if (bytes.length > maxBinaryBytes) {
    throw new OpenApiCallError("openapi_response_too_large", "The app's binary response was too large.", {
      status,
    });
  }
  return { bodyKind: "binary", base64: bytes.toString("base64") };
}

/** Send one operation. Throws OpenApiCallError with a safe code. */
export async function callOpenApiOperation(options: OpenApiCallOptions): Promise<OpenApiCallResult> {
  let base: URL;
  try {
    base = await assertMcpUrlAllowed(options.baseUrl, { env: options.env, lookup: options.lookup });
    routeOutbound(base, options.env);
  } catch (error) {
    if (error instanceof TailnetUnavailableError) {
      throw new OpenApiCallError("tailnet_unavailable", error.message);
    }
    if (error instanceof McpUrlPolicyError) {
      throw new OpenApiCallError("openapi_base_url_not_allowed", "The app address is not allowed.", {
        reason: error.reason,
      });
    }
    throw error;
  }
  const request = buildOpenApiRequest(options, base);
  const secrets = credentialValues(options.credentials, options.auth);
  let response: Response;
  try {
    response = await tailnetAwareFetch(options.env, options.fetchImpl, options.lookup)(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? OPENAPI_CALL_TIMEOUT_MS),
    });
  } catch (error) {
    if (isAbort(error)) throw new OpenApiCallError("openapi_timeout", "The app did not respond in time.");
    throw new OpenApiCallError("openapi_unreachable", "The app could not be reached.");
  }
  let bytes: Buffer;
  try {
    bytes = await readCapped(response, options.maxResponseBytes ?? OPENAPI_MAX_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof OpenApiCallError) throw error;
    if (isAbort(error)) throw new OpenApiCallError("openapi_timeout", "The app did not respond in time.");
    throw new OpenApiCallError("openapi_unreachable", "The app could not be reached.");
  }
  const contentType = response.headers.get("content-type");
  if (!response.ok) {
    let body: unknown;
    if (textual(contentType) && bytes.length) {
      // Scrub the whole body first (escaped and encoded forms included), then
      // the parsed values, and only then bound what is returned.
      const text = scrubSecrets(bytes.toString("utf8"), secrets);
      let parsed: unknown = text;
      try {
        parsed = scrubDeep(JSON.parse(text), secrets);
      } catch {
        parsed = text;
      }
      const serialized = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      body =
        serialized.length <= MAX_ERROR_BODY_CHARS
          ? parsed
          : `${serialized.slice(0, MAX_ERROR_BODY_CHARS - 14)}… [truncated]`;
    }
    const status = response.status;
    throw new OpenApiCallError(
      status === 401 || status === 403 ? "openapi_auth_rejected" : "openapi_http_error",
      status === 401 || status === 403
        ? "The app rejected the credentials."
        : `The app answered HTTP ${status}.`,
      { status, ...(body === undefined ? {} : { body }) },
    );
  }
  const decoded = decodeResponse(
    bytes,
    contentType,
    secrets,
    options.maxBinaryBytes ?? OPENAPI_MAX_BINARY_BYTES,
    response.status,
  );
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) {
      headers[name.toLowerCase()] = scrubSecrets(value, secrets);
    }
  });
  return {
    status: response.status,
    contentType,
    bytes: bytes.length,
    headers,
    ...(decoded.body === undefined ? {} : { body: scrubDeep(decoded.body, secrets) }),
    ...(decoded.text === undefined ? {} : { text: decoded.text }),
    ...(decoded.base64 === undefined ? {} : { base64: decoded.base64 }),
    bodyKind: decoded.bodyKind,
  };
}
