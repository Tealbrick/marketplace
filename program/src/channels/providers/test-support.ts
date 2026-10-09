import { createHash } from "node:crypto";
import type { AttachmentKind, OutboundAttachment } from "./types.js";

// Test-only helpers: a recording fake fetch and a fake clock. Never imported by runtime code.

export type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | FormData | undefined;
};

export type FakeReply = Response | Error | "hang" | (() => Response | Error | "hang");

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function createFakeFetch(replies: FakeReply[] = []) {
  const requests: RecordedRequest[] = [];
  const queue = [...replies];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    requests.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers,
      body: init?.body as string | FormData | undefined,
    });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("fake fetch: no reply queued");
    }
    const reply = typeof next === "function" ? next() : next;
    if (reply === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }) as typeof fetch;
  return { fetchImpl, requests, queue: (...more: FakeReply[]) => void queue.push(...more) };
}

export function createFakeClock(start = 1_000_000) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    sleeps,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** The kind defaults from the content type: image/*, audio/*, video/*, everything else is a file. */
export function kindOf(contentType: string): AttachmentKind {
  const major = contentType.split("/")[0];
  return major === "image" || major === "audio" || major === "video" ? major : "file";
}

export function attachment(
  name: string,
  contentType: string,
  content: string | Uint8Array = name,
  extra: { kind?: AttachmentKind; transcript?: string } = {},
): OutboundAttachment {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    kind: extra.kind ?? kindOf(contentType),
    ...(extra.transcript !== undefined ? { transcript: extra.transcript } : {}),
    bytes,
    contentType,
    name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Telegram method name of a recorded request without printing the URL (the URL holds the token). */
export function telegramMethod(request: RecordedRequest, token: string): string | undefined {
  const prefix = `https://api.telegram.org/bot${token}/`;
  return request.url.startsWith(prefix) ? request.url.slice(prefix.length) : undefined;
}
