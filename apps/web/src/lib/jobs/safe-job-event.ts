import "server-only";

import type { JobEventLevel, JobStage } from "@internal/db";
import { z } from "zod";

/**
 * Browser-safe operational event vocabulary. Persisted JobEvent.message is
 * untrusted operational history: an unknown message is deliberately omitted
 * instead of being rendered as user-facing text.
 */
export const safeJobEventMessages = [
  "QUEUE_ENQUEUED",
  "QUEUE_DELIVERY_PENDING",
  "QUEUE_RECEIVED",
  "QUEUE_SKIPPED",
  "JOB_CLAIMED",
  "JOB_HEARTBEAT",
  "JOB_PROGRESS",
  "JOB_COMPLETED",
  "JOB_FAILED",
  "JOB_CANCELED",
  "CANCEL_REQUESTED",
  "IMPORT_INCOMPLETE",
  "IMPORT_COMMITTED",
] as const;

export const safeJobEventReasons = [
  "MALFORMED_PAYLOAD",
  "UNKNOWN_JOB",
  "NOT_QUEUED",
  "CANCELED",
  "INACTIVE_DATASET",
  "UNSUPPORTED_TYPE",
  "TRANSPORT_CONFLICT",
  "QUEUE_UNAVAILABLE",
  "IMPORT_INCOMPLETE",
  "IMPORT_COMMIT_TIMEOUT",
] as const;

const safeJobEventMessageSchema = z.enum(safeJobEventMessages);
const safeJobEventReasonSchema = z.enum(safeJobEventReasons);

export type SafeJobEventMessage = z.infer<typeof safeJobEventMessageSchema>;
export type SafeJobEventReason = z.infer<typeof safeJobEventReasonSchema>;

export type SafeJobEvent = {
  id: string;
  createdAt: string;
  level: JobEventLevel;
  stage: JobStage | null;
  message: SafeJobEventMessage;
  reason: SafeJobEventReason | null;
};

type PersistedJobEvent = {
  id: string;
  createdAt: Date;
  level: JobEventLevel;
  stage: JobStage | null;
  message: string;
  data: unknown;
};

/** Converts a database event to the intentionally small browser DTO. */
export function toSafeJobEvent(event: PersistedJobEvent): SafeJobEvent | null {
  const message = safeJobEventMessageSchema.safeParse(event.message);
  if (!message.success) return null;

  // `data` is never serialized. It is consulted only for one known, scalar
  // reason value, and unknown shapes/values degrade to null.
  const candidateReason =
    event.data !== null && typeof event.data === "object" && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>).reason
      : undefined;
  const reason = safeJobEventReasonSchema.safeParse(candidateReason);

  return {
    id: event.id,
    createdAt: event.createdAt.toISOString(),
    level: event.level,
    stage: event.stage,
    message: message.data,
    reason: reason.success ? reason.data : null,
  };
}

const cursorPayloadSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().cuid(),
}).strict();

export type SafeJobEventCursor = z.infer<typeof cursorPayloadSchema>;

/** Opaque, URL-safe cursor for the `(createdAt DESC, id DESC)` event order. */
export function encodeSafeJobEventCursor(event: Pick<SafeJobEvent, "id" | "createdAt">): string {
  return Buffer.from(JSON.stringify({ createdAt: event.createdAt, id: event.id })).toString("base64url");
}

export function parseSafeJobEventCursor(cursor: string | null): SafeJobEventCursor | null {
  if (!cursor) return null;
  try {
    return cursorPayloadSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export const safeJobEventLimitSchema = z.coerce.number().int().min(1).max(100).default(50);
