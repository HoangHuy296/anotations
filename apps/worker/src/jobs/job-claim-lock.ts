import type { JobStatus, PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { z } from "zod";

import { writeSafeJobEvent } from "./job-event-writer.js";
import { claimJob as claimDurableJob } from "./job.repository.js";

const leaseDurationMs = 5 * 60 * 1000;

const jobReferenceSchema = z.object({ jobId: z.string().min(1), lockToken: z.string().min(1) });
const claimInputSchema = z.object({ jobId: z.string().min(1), workerId: z.string().min(1) });
const progressInputSchema = jobReferenceSchema.extend({
  stage: z.enum(["SCANNING_FILES", "UPLOADING_OBJECTS", "WRITING_ASSETS"]).optional(),
  progress: z.number().int().nonnegative().optional(),
  totalItems: z.number().int().nonnegative().nullable().optional(),
  processedItems: z.number().int().nonnegative().optional(),
  successItems: z.number().int().nonnegative().optional(),
  failedItems: z.number().int().nonnegative().optional(),
  skippedItems: z.number().int().nonnegative().optional(),
}).superRefine((value, context) => {
  const provided = [value.progress, value.totalItems, value.processedItems, value.successItems, value.failedItems, value.skippedItems];
  if (provided.every((item) => item === undefined)) context.addIssue({ code: "custom", message: "At least one progress value is required." });
  if (value.totalItems !== undefined && value.totalItems !== null && value.processedItems !== undefined && value.processedItems > value.totalItems) context.addIssue({ code: "custom", message: "processedItems cannot exceed totalItems." });
  if (value.processedItems !== undefined && (value.successItems ?? 0) + (value.failedItems ?? 0) + (value.skippedItems ?? 0) > value.processedItems) context.addIssue({ code: "custom", message: "Outcome counts cannot exceed processedItems." });
});
const completionInputSchema = jobReferenceSchema.extend({
  resultStorageKey: z.string().min(1).max(1_024).optional(),
  resultFilename: z.string().min(1).max(255).regex(/^[^/\\]+$/).optional(),
  stage: z.literal("FINISHED").optional(),
  summary: z.object({
    message: z.string().max(500).optional(),
    outcome: z.literal("completed").optional(),
    completedAt: z.string().datetime().optional(),
    resultCount: z.number().int().nonnegative().optional(),
    imported: z.number().int().nonnegative().optional(),
    skipped: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  totalItems: z.number().int().nonnegative().nullable().optional(),
  processedItems: z.number().int().nonnegative().optional(),
  successItems: z.number().int().nonnegative().optional(),
  failedItems: z.number().int().nonnegative().optional(),
  skippedItems: z.number().int().nonnegative().optional(),
}).strict();

export type ClaimResult = { kind: "claimed"; jobId: string; lockToken: string } | { kind: "refused" };
export type LeaseMutationResult = { kind: "updated" } | { kind: "refused" };

function leaseExpiresAt(now: Date) { return new Date(now.getTime() + leaseDurationMs); }
function currentLeaseWhere(jobId: string, lockToken: string, now: Date) { return { id: jobId, lockToken, lockedUntil: { gt: now } } as const; }

export async function claimJob(db: PrismaClient, input: unknown): Promise<ClaimResult> {
  const parsed = claimInputSchema.safeParse(input);
  if (!parsed.success) return { kind: "refused" };
  const claimed = await claimDurableJob(db, parsed.data.jobId, parsed.data.workerId);
  return claimed ? { kind: "claimed", jobId: claimed.job.id, lockToken: claimed.lockToken } : { kind: "refused" };
}

export async function heartbeatJob(db: PrismaClient, input: unknown): Promise<LeaseMutationResult> {
  const parsed = jobReferenceSchema.safeParse(input);
  if (!parsed.success) return { kind: "refused" };
  const now = new Date();
  const updated = await db.job.updateMany({ where: { ...currentLeaseWhere(parsed.data.jobId, parsed.data.lockToken, now), status: "RUNNING" }, data: { heartbeatAt: now, lockedUntil: leaseExpiresAt(now) } });
  if (updated.count !== 1) return { kind: "refused" };
  await writeSafeJobEvent(db, { jobId: parsed.data.jobId, kind: "JOB_HEARTBEAT" });
  return { kind: "updated" };
}

export async function updateJobProgress(db: PrismaClient, input: unknown): Promise<LeaseMutationResult> {
  const parsed = progressInputSchema.safeParse(input);
  if (!parsed.success) return { kind: "refused" };
  const now = new Date();
  const { jobId, lockToken, ...progress } = parsed.data;
  const updated = await db.job.updateMany({
    where: { ...currentLeaseWhere(jobId, lockToken, now), status: "RUNNING" },
    data: { ...(progress.stage !== undefined ? { stage: progress.stage } : {}), ...(progress.progress !== undefined ? { progress: progress.progress } : {}), ...(progress.totalItems !== undefined ? { totalItems: progress.totalItems } : {}), ...(progress.processedItems !== undefined ? { processedItems: progress.processedItems } : {}), ...(progress.successItems !== undefined ? { successItems: progress.successItems } : {}), ...(progress.failedItems !== undefined ? { failedItems: progress.failedItems } : {}), ...(progress.skippedItems !== undefined ? { skippedItems: progress.skippedItems } : {}) },
  });
  if (updated.count !== 1) return { kind: "refused" };
  await writeSafeJobEvent(db, { jobId, kind: "JOB_PROGRESS" });
  return { kind: "updated" };
}

function terminalData(status: JobStatus, now: Date) { return { status, finishedAt: now, lockedBy: null, lockToken: null, lockedAt: null, lockedUntil: null, heartbeatAt: null } as const; }

export async function completeJob(db: PrismaClient, input: unknown): Promise<LeaseMutationResult> {
  const parsed = completionInputSchema.safeParse(input);
  if (!parsed.success) return { kind: "refused" };
  const now = new Date();
  const { jobId, lockToken, ...completion } = parsed.data;
  const updated = await db.job.updateMany({
    where: { ...currentLeaseWhere(jobId, lockToken, now), status: "RUNNING" },
    data: { ...terminalData("COMPLETED", now), ...completion },
  });
  if (updated.count !== 1) return { kind: "refused" };
  await writeSafeJobEvent(db, { jobId, kind: "JOB_COMPLETED" });
  return { kind: "updated" };
}

export async function failJob(db: PrismaClient, input: unknown): Promise<LeaseMutationResult> {
  const parsed = jobReferenceSchema.safeParse(input);
  if (!parsed.success) return { kind: "refused" };
  const now = new Date();
  const updated = await db.job.updateMany({ where: { ...currentLeaseWhere(parsed.data.jobId, parsed.data.lockToken, now), status: "RUNNING" }, data: terminalData("FAILED", now) });
  if (updated.count !== 1) return { kind: "refused" };
  await writeSafeJobEvent(db, { jobId: parsed.data.jobId, kind: "JOB_FAILED" });
  return { kind: "updated" };
}

export async function cancelJob(db: PrismaClient, input: unknown): Promise<LeaseMutationResult> {
  const parsed = jobReferenceSchema.safeParse(input);
  if (!parsed.success) return { kind: "refused" };
  const now = new Date();
  const updated = await db.job.updateMany({
    where: { ...currentLeaseWhere(parsed.data.jobId, parsed.data.lockToken, now), status: { in: ["RUNNING", "CANCELING"] }, OR: [{ status: "CANCELING" }, { cancelRequestedAt: { not: null } }] },
    data: { ...terminalData("CANCELED", now), canceledAt: now },
  });
  if (updated.count !== 1) return { kind: "refused" };
  await writeSafeJobEvent(db, { jobId: parsed.data.jobId, kind: "JOB_CANCELED" });
  return { kind: "updated" };
}
