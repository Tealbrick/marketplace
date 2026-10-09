import { describe, expect, it } from "vitest";
import {
  DISCORD_CHANNEL_RULE,
  TELEGRAM_CHAT_RULE,
  TELEGRAM_GROUP_RULE,
  createRateLimiter,
  requestWithRetry,
  retryAfterSeconds,
} from "./rate.js";
import { createFakeClock } from "./test-support.js";
import type { HttpResult } from "./common.js";

function response(status: number, json: unknown, headers: Record<string, string> = {}): HttpResult {
  return { kind: "response", status, headers: new Headers(headers), json };
}

describe("token bucket", () => {
  it("lets the first message through and spaces a Telegram chat by 1 s", async () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter(clock);
    expect(await limiter.acquire("c1", [TELEGRAM_CHAT_RULE])).toEqual({ ok: true });
    expect(clock.sleeps).toEqual([]);
    await limiter.acquire("c1", [TELEGRAM_CHAT_RULE]);
    expect(clock.sleeps).toEqual([1000]);
  });

  it("keeps destinations independent and refills over time", async () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter(clock);
    await limiter.acquire("a", [TELEGRAM_CHAT_RULE]);
    await limiter.acquire("b", [TELEGRAM_CHAT_RULE]);
    expect(clock.sleeps).toEqual([]);
    clock.advance(5000);
    await limiter.acquire("a", [TELEGRAM_CHAT_RULE]);
    expect(clock.sleeps).toEqual([]);
  });

  it("enforces 20 per minute per group on top of 1 per second", async () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter(clock);
    const start = clock.now();
    for (let i = 0; i < 25; i++) {
      await limiter.acquire("g", [TELEGRAM_CHAT_RULE, TELEGRAM_GROUP_RULE]);
    }
    // 25 messages cannot fit in less than (25 - 20) * 3 s after the burst allowance is used up
    expect(clock.now() - start).toBeGreaterThanOrEqual(15_000);
    expect(clock.now() - start).toBeLessThan(40_000);
  });

  it("allows a Discord burst of 5 then 1 per second", async () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter(clock);
    for (let i = 0; i < 5; i++) {
      await limiter.acquire("d", [DISCORD_CHANNEL_RULE]);
    }
    expect(clock.sleeps).toEqual([]);
    await limiter.acquire("d", [DISCORD_CHANNEL_RULE]);
    expect(clock.sleeps).toEqual([1000]);
  });

  it("refuses instead of waiting longer than the maximum", async () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ ...clock, maxWaitMs: 500 });
    await limiter.acquire("c", [TELEGRAM_CHAT_RULE]);
    expect(await limiter.acquire("c", [TELEGRAM_CHAT_RULE])).toEqual({ ok: false, waitMs: 1000 });
    expect(clock.sleeps).toEqual([]);
  });
});

describe("retry_after parsing", () => {
  it("reads Telegram parameters, Discord body and the header, in that order", () => {
    const r = (status: number, json: unknown, headers?: Record<string, string>) =>
      response(status, json, headers) as Extract<HttpResult, { kind: "response" }>;
    expect(retryAfterSeconds(r(429, { parameters: { retry_after: 7 } }))).toBe(7);
    expect(retryAfterSeconds(r(429, { retry_after: 0.5 }))).toBe(0.5);
    expect(retryAfterSeconds(r(429, {}, { "retry-after": "9" }))).toBe(9);
    expect(retryAfterSeconds(r(429, { retry_after: -1 }))).toBeUndefined();
    expect(retryAfterSeconds(r(429, "oops", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }))).toBeUndefined();
  });
});

describe("requestWithRetry", () => {
  it("retries exactly once", async () => {
    const clock = createFakeClock();
    let calls = 0;
    const result = await requestWithRetry(async () => {
      calls++;
      return response(429, { retry_after: 1 });
    }, clock.sleep);
    expect(calls).toBe(2);
    expect(result).toMatchObject({ kind: "response", status: 429 });
    expect(clock.sleeps).toEqual([1000]);
  });

  it("does not retry other statuses or errors", async () => {
    const clock = createFakeClock();
    let calls = 0;
    await requestWithRetry(async () => {
      calls++;
      return { kind: "timeout" };
    }, clock.sleep);
    await requestWithRetry(async () => {
      calls++;
      return response(500, {});
    }, clock.sleep);
    expect(calls).toBe(2);
  });
});

describe("plan reservation", () => {
  it("reserves a multi-step cost at once, leaving the bucket in debt so the next send waits longer", async () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter(clock);
    expect(await limiter.acquire("c", [TELEGRAM_CHAT_RULE], 3)).toEqual({ ok: true });
    expect(clock.sleeps).toEqual([]);
    expect(await limiter.acquire("c", [TELEGRAM_CHAT_RULE])).toEqual({ ok: true });
    expect(clock.sleeps).toEqual([3000]);
  });

  it("refuses a plan that cannot start within the wait limit without taking any tokens", async () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter({ ...clock, maxWaitMs: 500 });
    expect(await limiter.acquire("c", [TELEGRAM_CHAT_RULE], 2)).toEqual({ ok: true });
    expect(await limiter.acquire("c", [TELEGRAM_CHAT_RULE], 2)).toEqual({ ok: false, waitMs: 2000 });
    clock.advance(2000);
    expect(await limiter.acquire("c", [TELEGRAM_CHAT_RULE])).toEqual({ ok: true });
  });
});
