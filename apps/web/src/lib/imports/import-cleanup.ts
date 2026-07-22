import "server-only";

import type { Client as MinioClient } from "minio";

import { db } from "@/lib/db";

function importPrefix(preparedImportId: string) {
  return `prepared-imports/${preparedImportId}/`;
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
 * Removes only unreferenced objects that belong to this preparation's private
 * prefix. One failed delete is isolated so a bulk cleanup can continue.
 */
export async function cleanupPreparedImportOrphans(input: { minio: MinioClient; bucket: string; preparedImportId: string }) {
  const prefix = importPrefix(input.preparedImportId);
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
