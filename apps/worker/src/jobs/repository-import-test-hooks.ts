import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

/**
 * Server-process-only fault controls for controlled repository-import tests.
 * They are deliberately unavailable unless both explicit integration flags are
 * set; no Job/API/browser input can select a fault point.
 */
export type RepositoryImportTestPoint =
  | "BEFORE_UPLOAD"
  | "AFTER_UPLOAD_BEFORE_PERSIST"
  | "AFTER_PERSIST_BEFORE_COMPLETE"
  | "AFTER_COMPLETE_BEFORE_ACK"
  | "CANCEL_BEFORE_PROVIDER"
  | "CANCEL_AFTER_UPLOAD"
  | "CANCEL_AFTER_BATCH";

function isEnabled() {
  return process.env.REPOSITORY_IMPORT_RUNTIME_TESTS === "1"
    && process.env.REPOSITORY_IMPORT_FAILURE_INJECTION === "1";
}

/** Returns only a stable synthetic error code; it never exposes environment values. */
export async function applyRepositoryImportTestPoint(
  db: PrismaClient,
  jobId: string,
  point: RepositoryImportTestPoint,
) {
  if (!isEnabled() || process.env.REPOSITORY_IMPORT_TEST_POINT !== point) return;
  if (point.startsWith("CANCEL_")) {
    await db.job.updateMany({
      where: { id: jobId, status: { in: ["RUNNING", "CANCELING"] } },
      data: { status: "CANCELING", cancelRequestedAt: new Date() },
    });
    return;
  }
  throw new Error("REPOSITORY_IMPORT_TEST_INJECTED_FAILURE");
}
