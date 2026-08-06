import "server-only";

import type { Client as MinioClient } from "minio";

import { db } from "@/lib/db";

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
 * import prefix. One failed delete is isolated so a bulk cleanup can continue.
 */
export async function cleanupPreparedImportOrphans(input: { minio: MinioClient; bucket: string; datasetId: string }) {
  const prefix = importPrefix(input.datasetId);
  const keys = await listObjects(input.minio, input.bucket, prefix);
  let removed = 0;
  let failed = 0;
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    try {
      const asset = await db.asset.findFirst({ where: { storageBucket: input.bucket, storageKey: key, deletedAt: null }, select: { id: true } });
      if (asset) continue;
      await input.minio.removeObject(input.bucket, key);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

export { importPrefix, listObjects as listPreparedImportObjects };
