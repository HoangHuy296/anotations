/**
 * Shared, allowlisted, single-line-JSON structured logger
 * (021-production-hardening-garbage-collection, research.md decision 9).
 *
 * Deliberately small — "basic operational visibility," not a monitoring
 * platform, and no new logging dependency (pino/winston) is introduced.
 * Shared here (rather than duplicated per app) so `apps/web` and
 * `apps/worker` emit the exact same line shape and redaction behavior.
 *
 * Every helper's field type is a closed, per-category shape (job/redis/
 * storage/ai) — callers cannot widen it with arbitrary keys at the type
 * level. `assertSafe` is defense-in-depth against a caller spreading a
 * free-form object (e.g. a caught error's `.message`, or a `reason` string)
 * that happens to contain a disallowed key or an obvious secret-shaped
 * value. Per AGENTS.md's security rules and FR-050: never a credential,
 * signed URL, access token, provider secret, or raw asset/job payload.
 */

export type LogLevel = "info" | "error";

const DISALLOWED_KEY_PATTERN = /token|password|secret|signedurl|signed_url|credential|accesskey|access_key|connectionstring|connection_string/i;

/**
 * Throws in non-production so a disallowed key is caught immediately during
 * development/tests, rather than ever reaching a log sink. In production,
 * never crashes job/request processing over a logging mistake — the
 * offending value is redacted in place and the (now-safe) line is still
 * emitted, so the underlying operation is never silently blocked by this.
 */
function assertSafe(fields: Record<string, unknown>): Record<string, unknown> {
  const offendingKeys = Object.keys(fields).filter((key) => DISALLOWED_KEY_PATTERN.test(key));
  if (offendingKeys.length === 0) return fields;
  if (process.env.NODE_ENV !== "production") {
    throw new Error(
      `log(): payload contains a disallowed key (${offendingKeys.join(", ")}). ` +
        "Credentials, tokens, passwords, and signed URLs must never be logged.",
    );
  }
  const safe = { ...fields };
  for (const key of offendingKeys) safe[key] = "[REDACTED]";
  return safe;
}

function emit(level: LogLevel, category: "job" | "redis" | "storage" | "ai" | "maintenance", event: string, fields: Record<string, unknown>) {
  const safeFields = assertSafe(fields);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    category,
    event,
    ...safeFields,
  });
  // eslint-disable-next-line no-console -- this *is* the logging sink.
  if (level === "error") console.error(line);
  else console.info(line);
}

export type JobLogFields = {
  jobId: string;
  type?: string;
  status?: string;
  attempts?: number;
  reason?: string;
  durationMs?: number;
};

/**
 * Job lifecycle transitions (FR-046): created, queued, claimed, started,
 * completed, failed, retried, recovered, dead-lettered, canceled. `event`
 * is the transition name, e.g. `"JOB_RECOVERED"` — pass the same vocabulary
 * used by `apps/worker/src/jobs/job-event-writer.ts`'s `JobEventKind` where
 * applicable, so a log line and its corresponding `JobEvent` row read the
 * same way. Never pass `Job.input`/`Job.state`/`Job.errorDetails` — those
 * carry request-shaped or provider-shaped content this logger has no
 * allowlist for.
 */
export function logJobEvent(event: string, fields: JobLogFields, level: LogLevel = "info") {
  emit(level, "job", event, fields);
}

export type RedisLogFields = { detail?: string };

/** Redis/queue connection failures, reconnects, enqueue failures (FR-047). */
export function logRedisEvent(event: string, fields: RedisLogFields = {}, level: LogLevel = "info") {
  emit(level, "redis", event, fields);
}

export type StorageLogFields = { bucket?: string; key?: string; reason?: string };

/** Storage upload/delete failures, orphan detection (FR-048). */
export function logStorageEvent(event: string, fields: StorageLogFields = {}, level: LogLevel = "info") {
  emit(level, "storage", event, fields);
}

export type AiLogFields = {
  aiTaskId: string;
  jobId?: string;
  modelId?: string;
  provider?: string;
  reason?: string;
  durationMs?: number;
};

/**
 * AI task lifecycle transitions (FR-049): aiTaskId, jobId, modelId,
 * provider identity, the transition, failure reason, duration. Never the
 * raw provider request/response payload.
 */
export function logAiEvent(event: string, fields: AiLogFields, level: LogLevel = "info") {
  emit(level, "ai", event, fields);
}

export type MaintenanceLogFields = {
  retentionDays?: number;
  batchSize?: number;
  deleted?: number;
  batches?: number;
  durationMs?: number;
  reason?: string;
};

/**
 * Bulk/scheduled maintenance passes that don't correspond to a single Job
 * (021-production-hardening-garbage-collection, e.g. JobEvent retention
 * cleanup) — `logJobEvent` requires a `jobId`, which doesn't fit a pass
 * that touches many jobs' events at once.
 */
export function logMaintenanceEvent(event: string, fields: MaintenanceLogFields = {}, level: LogLevel = "info") {
  emit(level, "maintenance", event, fields);
}
