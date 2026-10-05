import { z } from "zod";

// Phase029 repository accounting partitions the discovered item set. Publication
// is per item: an incomplete import retains accepted Assets. Terminal mutations
// use the existing lease/state CAS and JOB_COMPLETED/JOB_FAILED event writers.
// Durable Job item counters are Prisma Int / PostgreSQL int4. Reject impossible
// accounting before handing a terminal payload to the database.
export const repositoryJobCountMaximum = 2_147_483_647;
const count = z.number().int().nonnegative().max(repositoryJobCountMaximum);
const accounting = z.object({
  accepted: count, unchanged: count, rejected: count, retryable: count,
  skipped: count, unprocessed: count,
});
export const repositoryCompletedSummary = accounting.extend({
  outcome: z.literal("completed"), resultCount: count,
}).strict().superRefine((value, context) => {
  if (value.resultCount !== value.accepted + value.unchanged ||
      value.rejected + value.retryable + value.skipped + value.unprocessed !== 0) {
    context.addIssue({ code: "custom", message: "Completed ingestion accounting is inconsistent." });
  }
});
export const repositoryIncompleteSummary = accounting.extend({
  outcome: z.literal("incomplete"),
}).strict().superRefine((value, context) => {
  if (value.rejected + value.retryable + value.skipped + value.unprocessed === 0) {
    context.addIssue({ code: "custom", message: "Incomplete ingestion requires an incomplete item." });
  }
});

type TerminalCounts = {
  summary?: unknown; stage?: string; progress?: number; totalItems?: number | null; processedItems?: number;
  successItems?: number; failedItems?: number; skippedItems?: number;
};
export function validateRepositoryTerminalCounts(value: TerminalCounts, context: z.RefinementCtx) {
  if (!value.summary || typeof value.summary !== "object" || !("accepted" in value.summary)) return;
  if (value.stage !== "FINISHED" || value.progress !== 100) {
    context.addIssue({ code: "custom", message: "Repository terminal accounting requires FINISHED and full progress." });
  }
  const summary = value.summary as z.infer<typeof accounting>;
  const processed = summary.accepted + summary.unchanged + summary.rejected + summary.retryable + summary.skipped;
  if (!Number.isSafeInteger(processed + summary.unprocessed) || processed + summary.unprocessed > repositoryJobCountMaximum ||
      value.totalItems !== processed + summary.unprocessed || value.processedItems !== processed ||
      value.successItems !== summary.accepted + summary.unchanged ||
      value.failedItems !== summary.rejected + summary.retryable || value.skippedItems !== summary.skipped) {
    context.addIssue({ code: "custom", message: "Repository summary must match durable Job counts." });
  }
}
