import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";

/**
 * Shared protections of the public inbound routes (Teams messaging endpoint, Slack Events API, Telegram
 * webhook): the source address behind the one trusted proxy and a per-source request budget, both checked in
 * `onRequest`, before the body is read or parsed.
 */

/** The address the one trusted proxy appended (last X-Forwarded-For entry), else the socket address. */
export function sourceOf(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
  const last = value?.split(",").pop()?.trim();
  return last && last.length <= 64 ? last : request.ip;
}

export type SourceRate = { capacity: number; refillPerSecond: number };

/** A token bucket per source address (bounded map). `take(source)` is false when the source is over budget. */
export function createSourceBudget(rate: SourceRate, clock: () => number = () => Date.now()) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(source: string): boolean {
      const now = clock();
      if (buckets.size > 10_000) {
        for (const [key, bucket] of buckets) if (now - bucket.at > 10 * 60_000) buckets.delete(key);
        if (buckets.size > 10_000) buckets.clear();
      }
      const bucket = buckets.get(source) ?? { tokens: rate.capacity, at: now };
      bucket.tokens = Math.min(rate.capacity, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * rate.refillPerSecond);
      bucket.at = now;
      buckets.set(source, bucket);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}

/** The first value of a request header, or undefined. */
export function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : undefined;
}

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Constant-time: does sha256(value) equal the stored hex digest? */
export function matchesDigest(value: string, digestHex: string): boolean {
  const left = createHash("sha256").update(value, "utf8").digest();
  const right = Buffer.from(digestHex, "hex");
  return right.length === left.length && timingSafeEqual(left, right);
}
