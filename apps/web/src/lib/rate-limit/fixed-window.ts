import "server-only";

import { Redis } from "ioredis";

import { logRedisEvent } from "@annotationplatform/domain";
import { readProviderConfig } from "@annotationplatform/domain";

/**
 * Redis-backed per-user rate limiting
 * (021-production-hardening-garbage-collection, User Story 7, FR-037–040).
 *
 * A fixed-window `INCR`+`EXPIRE` counter keyed
 * `ratelimit:{userId}:{category}:{windowStart}` — the simplest correct
 * primitive for "prevent one user from creating unlimited background jobs"
 * (research.md decision 7). This is the one, explicitly non-authoritative
 * piece of Redis-resident state this feature introduces: losing this key
 * (a Redis restart, or the outage case below) only ever *relaxes* the
 * limit temporarily — no `Job` field or lifecycle decision ever depends on
 * it, so AGENTS.md's "Redis is transport only, never a Job store" is not
 * violated by this ephemeral, purely protective counter.
 *
 * One shared, lazily-created connection per server process (not one per
 * request, unlike `createWebQueue()`'s per-request BullMQ client) — this
 * runs on every job-creating request and a fresh TCP+AUTH handshake each
 * time would add needless latency to a check that's supposed to be cheap.
 */
let sharedConnection: Redis | undefined;

function getConnection(): Redis {
  if (sharedConnection) return sharedConnection;
  const config = readProviderConfig();
  const connection = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    db: config.REDIS_DB,
    // A rate-limit check must never hang a browser-facing request — bound
    // retries so an unreachable Redis fails fast into the catch block
    // below instead of the request hanging on ioredis's default unlimited
    // retry queue.
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
  connection.on("error", (error) => {
    logRedisEvent("CONNECTION_ERROR", { detail: error instanceof Error ? error.message : "unknown error" }, "error");
  });
  sharedConnection = connection;
  return connection;
}

export type RateLimitCategory = "ai-task" | "import" | "export";

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export async function checkRateLimit(input: {
  userId: string;
  category: RateLimitCategory;
  limit: number;
  windowSeconds?: number;
  /** Test-only injection seam — production callers always use the shared connection. */
  connection?: Redis;
}): Promise<RateLimitResult> {
  const windowSeconds = input.windowSeconds ?? 60;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const key = `ratelimit:${input.userId}:${input.category}:${windowStart}`;

  try {
    const connection = input.connection ?? getConnection();
    const count = await connection.incr(key);
    if (count === 1) {
      // Only the request that actually creates the key sets its expiry —
      // avoids resetting the TTL on every subsequent increment within the
      // same window.
      await connection.expire(key, windowSeconds);
    }
    if (count > input.limit) {
      const retryAfterSeconds = Math.max(windowStart + windowSeconds - nowSeconds, 1);
      return { allowed: false, retryAfterSeconds };
    }
    return { allowed: true };
  } catch (error) {
    // 021-...(FR-017-adjacent principle, applied here too): never swallow
    // a Redis failure silently — log it. But this counter is explicitly
    // protective, not correctness-critical (unlike a Job's own durable
    // state), and Redis is not authoritative for it — failing *closed*
    // here would mean a Redis outage blocks all legitimate job creation
    // too, a worse availability outcome than the abuse this guards
    // against. Fail open (allow), loudly logged, not silently.
    logRedisEvent("RATE_LIMIT_CHECK_FAILED", { detail: error instanceof Error ? error.message : "unknown error" }, "error");
    return { allowed: true };
  }
}
