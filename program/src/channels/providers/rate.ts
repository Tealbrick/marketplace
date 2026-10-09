import type { HttpResult } from "./common.js";

// Provider layer of the three rate caps (spec section 9, layer 1):
// a per-destination token bucket plus one honoured retry_after on HTTP 429.

export type RateRule = {
  name: string;
  /** Burst size in messages. */
  capacity: number;
  /** Sustained refill in messages per second. */
  refillPerSecond: number;
};

/** Telegram: about 1 message per second in one chat. */
export const TELEGRAM_CHAT_RULE: RateRule = { name: "per-second", capacity: 1, refillPerSecond: 1 };
/** Telegram: 20 messages per minute in one group or channel. */
export const TELEGRAM_GROUP_RULE: RateRule = { name: "per-minute", capacity: 20, refillPerSecond: 20 / 60 };
/** Discord: conservative 5 messages per 5 seconds per channel. */
export const DISCORD_CHANNEL_RULE: RateRule = { name: "per-5s", capacity: 5, refillPerSecond: 1 };

/** A 429 whose retry_after is longer than this is not waited for. */
export const MAX_RETRY_AFTER_SECONDS = 30;

type Bucket = { tokens: number; updatedAt: number };

export type RateLimiter = {
  acquire(
    key: string,
    rules: readonly RateRule[],
    cost?: number,
  ): Promise<{ ok: true } | { ok: false; waitMs: number }>;
};

export function createRateLimiter(input: {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Longest wait the limiter accepts before it refuses. Default 30 s. */
  maxWaitMs?: number;
}): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const maxWaitMs = input.maxWaitMs ?? MAX_RETRY_AFTER_SECONDS * 1000;

  function bucketFor(key: string, rule: RateRule, at: number): Bucket {
    const id = `${key}\u0000${rule.name}`;
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { tokens: rule.capacity, updatedAt: at };
      buckets.set(id, bucket);
    }
    const elapsedSeconds = Math.max(0, (at - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(rule.capacity, bucket.tokens + elapsedSeconds * rule.refillPerSecond);
    bucket.updatedAt = at;
    return bucket;
  }

  function prune(at: number) {
    if (buckets.size <= 1000) {
      return;
    }
    for (const [id, bucket] of buckets) {
      if (at - bucket.updatedAt > 10 * 60 * 1000) {
        buckets.delete(id);
      }
    }
  }

  return {
    async acquire(key, rules, cost = 1) {
      for (;;) {
        const at = input.now();
        prune(at);
        let waitMs = 0;
        const taken: Array<{ bucket: Bucket; need: number }> = [];
        for (const rule of rules) {
          const bucket = bucketFor(key, rule, at);
          // A multi-step send reserves its whole cost at once. It waits only for
          // min(cost, capacity) tokens and may leave the bucket in debt, so a later
          // send waits longer; a local limit never cuts a send in half.
          const need = Math.max(1, cost);
          const ready = Math.min(need, rule.capacity);
          taken.push({ bucket, need });
          if (bucket.tokens < ready) {
            waitMs = Math.max(waitMs, Math.ceil(((ready - bucket.tokens) / rule.refillPerSecond) * 1000));
          }
        }
        if (waitMs === 0) {
          for (const { bucket, need } of taken) {
            bucket.tokens -= need;
          }
          return { ok: true };
        }
        if (waitMs > maxWaitMs) {
          return { ok: false, waitMs };
        }
        await input.sleep(waitMs);
      }
    },
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * retry_after in seconds from a 429 response.
 * Telegram: `parameters.retry_after`. Discord: `retry_after` in the JSON body. Both: `Retry-After` header.
 */
export function retryAfterSeconds(result: Extract<HttpResult, { kind: "response" }>): number | undefined {
  const json = result.json;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const record = json as Record<string, unknown>;
    const parameters = record.parameters;
    if (parameters && typeof parameters === "object") {
      const fromParameters = finiteNonNegative((parameters as Record<string, unknown>).retry_after);
      if (fromParameters !== undefined) {
        return fromParameters;
      }
    }
    const fromBody = finiteNonNegative(record.retry_after);
    if (fromBody !== undefined) {
      return fromBody;
    }
  }
  const header = result.headers.get("retry-after");
  if (header && /^\d+(\.\d+)?$/u.test(header.trim())) {
    return finiteNonNegative(Number(header.trim()));
  }
  return undefined;
}

/**
 * Runs a request. On HTTP 429 with a usable retry_after of at most 30 s it waits and runs the request ONCE more.
 * A second 429, a longer or missing retry_after, or any other result is returned as is.
 * The caller maps a final 429 to a failed result with errorCode provider_rate_limited.
 * A 429 means the provider rejected the request, so the retry cannot duplicate a message.
 */
export async function requestWithRetry(
  run: () => Promise<HttpResult>,
  sleep: (ms: number) => Promise<void>,
): Promise<HttpResult> {
  const first = await run();
  if (first.kind !== "response" || first.status !== 429) {
    return first;
  }
  const seconds = retryAfterSeconds(first);
  if (seconds === undefined || seconds > MAX_RETRY_AFTER_SECONDS) {
    return first;
  }
  await sleep(Math.ceil(seconds * 1000));
  return run();
}
