import { createHash } from "node:crypto";
import { oggPageCrc } from "./ogg-opus.js";
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

/**
 * A valid Ogg/Opus file (mono, 48 kHz, CRC-correct pages) whose audio packets have the given sizes in bytes.
 * Each packet is one 20 ms CELT frame (TOC 0xF8) padded to its size; at most 50 packets per page.
 */
export function buildOggOpus(packetSizes: readonly number[], options: { preSkip?: number; lastGranule?: bigint } = {}): Uint8Array {
  const preSkip = options.preSkip ?? 312;
  const serial = 0x1234abcd;
  const pages: Uint8Array[] = [];
  let sequence = 0;
  const page = (flags: number, granule: bigint, packets: Uint8Array[]) => {
    const lacing: number[] = [];
    for (const packet of packets) {
      let remaining = packet.length;
      while (remaining >= 255) {
        lacing.push(255);
        remaining -= 255;
      }
      lacing.push(remaining);
    }
    const header = Buffer.alloc(27 + lacing.length);
    header.write("OggS", 0, "latin1");
    header.writeUInt8(flags, 5);
    header.writeBigInt64LE(granule, 6);
    header.writeUInt32LE(serial, 14);
    header.writeUInt32LE(sequence++, 18);
    header.writeUInt8(lacing.length, 26);
    lacing.forEach((value, index) => header.writeUInt8(value, 27 + index));
    const whole = Buffer.concat([header, ...packets]);
    whole.writeUInt32LE(oggPageCrc(whole), 22);
    pages.push(whole);
  };
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head.writeUInt8(1, 8);
  head.writeUInt8(1, 9);
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(48_000, 12);
  const tags = Buffer.alloc(16);
  tags.write("OpusTags", 0, "latin1");
  page(0x02, 0n, [head]);
  page(0, 0n, [tags]);
  const packets = packetSizes.map((size) => {
    const packet = new Uint8Array(Math.max(1, size)).fill(0x55);
    packet[0] = 0xf8;
    return packet;
  });
  let granule = 0n;
  for (let start = 0; start < packets.length; start += 50) {
    const chunk = packets.slice(start, start + 50);
    granule += BigInt(chunk.length * 960);
    const last = start + 50 >= packets.length;
    page(last ? 0x04 : 0, last && options.lastGranule !== undefined ? options.lastGranule : granule, chunk);
  }
  return Uint8Array.from(Buffer.concat(pages));
}
