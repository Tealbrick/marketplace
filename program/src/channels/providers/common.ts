import { createHash } from "node:crypto";
import { retryAfterSeconds } from "./rate.js";
import type {
  ChannelFileCapability,
  ChannelProviderOptions,
  OutboundAttachment,
  SendResult,
  SendStatus,
} from "./types.js";

// Shared HTTP, scrubbing and validation helpers for the Telegram and Discord adapters.

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TITLE_CHARS = 128;
const MAX_DETAIL_CHARS = 200;
const REDACTED = "[redacted]";

export type ProviderRuntime = {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
};

export function resolveRuntime(options: ChannelProviderOptions = {}): ProviderRuntime {
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  return {
    fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
    sleep: options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now: options.now ?? (() => Date.now()),
    timeoutMs,
  };
}

// ---------------------------------------------------------------- HTTP

export type HttpResult =
  | { kind: "response"; status: number; headers: Headers; json: unknown }
  | { kind: "timeout" }
  | { kind: "network"; code?: string };

/**
 * One HTTP call. Never throws. The timeout covers the response headers and the body.
 * "timeout" and "network" mean the request may have reached the provider.
 */
export async function httpRequest(
  runtime: ProviderRuntime,
  url: string,
  init: RequestInit,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  try {
    const response = await runtime.fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
    const text = await response.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { kind: "response", status: response.status, headers: response.headers, json };
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
      return { kind: "timeout" };
    }
    // Only a short upper-case error code is kept. The error message can contain the request URL.
    const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    const rawCode =
      (cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined) ??
      (error instanceof Error ? (error as { code?: unknown }).code : undefined);
    const code = typeof rawCode === "string" && /^[A-Z0-9_]{2,40}$/u.test(rawCode) ? rawCode : undefined;
    return code ? { kind: "network", code } : { kind: "network" };
  } finally {
    clearTimeout(timer);
  }
}

export function isSuccess(result: HttpResult): result is Extract<HttpResult, { kind: "response" }> {
  return result.kind === "response" && result.status >= 200 && result.status < 300;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

// ---------------------------------------------------------------- Secrets and untrusted text

const GENERIC_SECRET_PATTERNS: RegExp[] = [
  /bot\d{3,}:[A-Za-z0-9_-]{16,}/gu,
  /\d{6,}:[A-Za-z0-9_-]{30,}/gu,
  /Bot\s+[A-Za-z0-9._-]{20,}/gu,
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/gu,
];

/** Removes every secret form (raw, URL-encoded, `bot<token>`, generic token shapes) from text. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret) {
      forms.add(secret);
      forms.add(encodeURIComponent(secret));
    }
  }
  let out = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    out = out.split(form).join(REDACTED);
  }
  for (const pattern of GENERIC_SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

// Control characters, bidirectional overrides and zero-width marks.
const UNSAFE_TEXT = /[\p{Cc}​-‏‪-‮⁦-⁩؜﻿]/gu;

function capCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length > max ? points.slice(0, max).join("") : text;
}

/** Untrusted provider text for titles: control characters removed, whitespace collapsed, capped. */
export function sanitizeText(value: unknown, max = MAX_TITLE_CHARS): string {
  if (typeof value !== "string") {
    return "";
  }
  return capCodePoints(value.replace(UNSAFE_TEXT, " ").replace(/\s+/gu, " ").trim(), max);
}

/** Provider error text for `detail`: scrubbed, sanitised, capped. */
export function safeDetail(value: unknown, secrets: readonly string[]): string | undefined {
  const text = sanitizeText(scrubSecrets(typeof value === "string" ? value : "", secrets), MAX_DETAIL_CHARS);
  return text || undefined;
}

export function sanitizeFilename(name: string): string {
  const cleaned = sanitizeText(name.replace(/[\\/]/gu, "_"), 100).replace(/^\.+/u, "");
  return cleaned || "file";
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export type RequestBody = { body: NonNullable<RequestInit["body"]>; headers?: Record<string, string> };

/** Last line of defence: an unexpected exception becomes a fixed, token-free result. */
export async function guard<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

export function toBlob(bytes: Uint8Array, contentType: string): Blob {
  return new Blob([bytes as unknown as ArrayBuffer], { type: normalizeContentType(contentType) || "application/octet-stream" });
}

// ---------------------------------------------------------------- Results

export function refuse(errorCode: string, detail: string): SendResult {
  return { status: "failed", resultIds: [], resultUrls: [], errorCode, detail };
}

export type Failure = { status: Exclude<SendStatus, "sent">; errorCode: string; detail: string };

/**
 * Maps a non-success HTTP outcome of a send call to a result.
 * - timeout or network error: uncertain / provider_timeout (the request may have been delivered).
 * - 401: failed / credential_invalid. 403: failed / provider_forbidden.
 * - 404: failed, credential_invalid for Telegram (unknown bot token) or provider_not_found for Discord.
 * - 429: failed / provider_rate_limited (the single allowed retry already happened in requestWithRetry).
 * - other 4xx (incl. 400): failed / provider_rejected with a scrubbed provider message.
 * - 503: failed / provider_unavailable (the provider refused the request before handling it).
 * - 500, 502, 504, any other 5xx or unexpected status: uncertain / provider_unexpected_status. The message
 *   may have been posted; an uncertain post blocks a retry until the owner resolves it (never double-post).
 */
export function classifyFailure(
  result: HttpResult,
  options: {
    secrets: readonly string[];
    message: (json: unknown) => unknown;
    notFound: "credential_invalid" | "provider_not_found";
  },
): Failure {
  if (result.kind === "timeout") {
    return {
      status: "uncertain",
      errorCode: "provider_timeout",
      detail: "request timed out after it started; delivery is unknown",
    };
  }
  if (result.kind === "network") {
    return {
      status: "uncertain",
      errorCode: "provider_timeout",
      detail: `network error before a response${result.code ? ` (${result.code})` : ""}; delivery is unknown`,
    };
  }
  const { status } = result;
  const message = safeDetail(options.message(result.json), options.secrets);
  if (status === 429) {
    const seconds = retryAfterSeconds(result);
    return {
      status: "failed",
      errorCode: "provider_rate_limited",
      detail: seconds === undefined ? "rate limited by the provider" : `rate limited by the provider; retry_after ${seconds}s`,
    };
  }
  if (status === 401) {
    return { status: "failed", errorCode: "credential_invalid", detail: "the provider rejected the credential" };
  }
  if (status === 403) {
    return { status: "failed", errorCode: "provider_forbidden", detail: message ?? "forbidden" };
  }
  if (status === 404) {
    return options.notFound === "credential_invalid"
      ? { status: "failed", errorCode: "credential_invalid", detail: "the provider does not know this credential" }
      : { status: "failed", errorCode: "provider_not_found", detail: message ?? "not found" };
  }
  if (status >= 400 && status < 500) {
    return { status: "failed", errorCode: "provider_rejected", detail: message ?? `HTTP ${status}` };
  }
  if (status === 503) {
    return { status: "failed", errorCode: "provider_unavailable", detail: `provider returned HTTP ${status}` };
  }
  return {
    status: "uncertain",
    errorCode: "provider_unexpected_status",
    detail: `provider returned HTTP ${status}; delivery is unknown`,
  };
}

// ---------------------------------------------------------------- Validation

/** Limits checked before any request. Returns a refusal or undefined. */
export function validateOutbound(input: {
  text: string;
  attachments: readonly OutboundAttachment[];
  maxChars: number;
  files: ChannelFileCapability | false;
}): SendResult | undefined {
  const { text, attachments, maxChars, files } = input;
  if (text.length > maxChars) {
    return refuse("channel_text_too_long", `text is ${text.length} characters; this provider allows ${maxChars}`);
  }
  if (text.trim().length === 0 && attachments.length === 0) {
    return refuse("channel_message_empty", "a message needs text or at least one attachment");
  }
  if (attachments.length > 0) {
    if (files === false) {
      return refuse("channel_files_unsupported", "this provider does not accept files");
    }
    if (attachments.length > files.maxCount) {
      return refuse("channel_too_many_files", `${attachments.length} files; this provider allows ${files.maxCount}`);
    }
    for (const attachment of attachments) {
      if (!files.types.includes(normalizeContentType(attachment.contentType))) {
        return refuse("channel_file_type_not_allowed", "a file type is not allowed on this provider");
      }
      if (attachment.bytes.byteLength > files.maxBytes) {
        return refuse("channel_file_too_large", `a file is larger than ${files.maxBytes} bytes`);
      }
      if (sha256Hex(attachment.bytes) !== attachment.sha256.toLowerCase()) {
        return refuse("channel_file_digest_mismatch", "a file does not match its approved SHA-256");
      }
    }
  }
  return undefined;
}
