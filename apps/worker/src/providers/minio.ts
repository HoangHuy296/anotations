import { Client as MinioClient } from "minio";

import type { ProviderConfig } from "@annotationplatform/domain";

export function createWorkerMinio(config: ProviderConfig) {
  const endpoint = new URL(config.MINIO_ENDPOINT);
  return new MinioClient({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    useSSL: endpoint.protocol === "https:",
    accessKey: config.MINIO_ACCESS_KEY,
    secretKey: config.MINIO_SECRET_KEY,
  });
}

export async function ensureBucket(client: MinioClient, bucket: string) {
  if (!(await client.bucketExists(bucket))) {
    await client.makeBucket(bucket);
  }
}

/**
 * MinIO lifecycle policy — secondary GC safety net
 * (021-production-hardening-garbage-collection, User Story 4, FR — "MinIO
 * Lifecycle Policy"). Scoped by `Filter.Prefix` to *only* the two known
 * temp/staging prefixes (`prepared-imports/`, `direct-uploads/` —
 * `temp-upload-cleanup.ts`'s own scope). Every permanent asset prefix
 * (nothing under those two names) has no matching rule and is therefore
 * never touched by this policy, by construction — MinIO/S3 lifecycle
 * expiration only ever applies to objects matching a rule's prefix filter.
 *
 * Deliberately a *secondary* safety net, not the primary GC mechanism: this
 * expiration is unconditional on object age alone (MinIO has no concept of
 * "check whether a Postgres row still references this key" — a lifecycle
 * rule cannot consult the database), so it is set to a expiration window
 * generously longer than the code-based `TEMP_UPLOAD_RETENTION_MS` (which
 * *does* re-check references before deleting). If the code-based cleanup
 * (`temp-upload-cleanup.ts`) is ever down or falls behind, this catches
 * what it misses — never the reverse. `expirationDays` uses MinIO's native
 * day-granularity; sub-day precision belongs to the code-based cleanup.
 *
 * Idempotent — matches `ensureBucket`'s pattern; setting the same
 * configuration again is a no-op change.
 */
export async function ensureTempUploadLifecyclePolicy(client: MinioClient, bucket: string, expirationDays: number) {
  await client.setBucketLifecycle(bucket, {
    Rule: [
      { ID: "annotationplatform-expire-prepared-imports", Status: "Enabled", Filter: { Prefix: "prepared-imports/" }, Expiration: { Days: expirationDays } },
      { ID: "annotationplatform-expire-direct-uploads", Status: "Enabled", Filter: { Prefix: "direct-uploads/" }, Expiration: { Days: expirationDays } },
    ],
  });
}
