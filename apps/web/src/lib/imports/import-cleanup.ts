import "server-only";

import type { Client as MinioClient } from "minio";

import { db } from "@/lib/db";
// 021-production-hardening-garbage-collection: the deletion logic below is
// now a thin caller of the shared GC primitive (research.md decision 5) —
// apps/worker/src/queue/minio-orphan-scanner.ts's sweepUnreferencedObjects,
// which the general orphan scanner, deleted-asset/dataset cleanup, and
// temp-upload cleanup all build on too, rather than four bespoke
// implementations of the same "list → check reference → delete" shape.
// Cross-app import is an established pattern here (see e.g.
// apps/web/tests/job-queue/recovery-scanner.test.ts importing the worker's
// recovery-scanner.js directly).
import { sweepUnreferencedObjects } from "../../../../worker/src/queue/minio-orphan-scanner.js";

// Storage keys are grouped by Dataset, not by individual import batch (see
// prepare-local-folder-import.ts), so orphan cleanup scans the whole
// Dataset's prefix. Each object is still checked against the database
// individually below, so a real, published Asset from a different import
// batch is never at risk of being deleted.
function importPrefix(datasetId: string) {
  return `prepared-imports/${datasetId}/`;
}

async function listObjects(minio: MinioClient, bucket: string, prefix: string) {
  return new Promise<string[]>((resolve, reject) => {
    const keys: string[] = [];
    const stream = minio.listObjects(bucket, prefix, true);
    stream.on("data", (entry) => { if (entry.name) keys.push(entry.name); });
    stream.once("error", reject);
    stream.once("end", () => resolve(keys));
  });
}

/**
 * Removes only unreferenced objects that belong to this Dataset's prepared-
 * import prefix. No grace period here (this call site's existing contract,
 * preserved exactly — its own caller already knows the import is done with
 * these objects, unlike the ambient periodic orphan scanner which cannot
 * assume that). Idempotent: an object already removed by an earlier call
 * simply doesn't reappear in the next listing.
 */
export async function cleanupPreparedImportOrphans(input: { minio: MinioClient; bucket: string; datasetId: string }) {
  const prefix = importPrefix(input.datasetId);
  const result = await sweepUnreferencedObjects({ db, minio: input.minio, bucket: input.bucket, prefix, dryRun: false, gracePeriodMs: 0 });
  return { removed: result.deleted.length, failed: result.failed.length };
}

export { importPrefix, listObjects as listPreparedImportObjects };
