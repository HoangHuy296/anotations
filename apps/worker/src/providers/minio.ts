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
 * Lifecycle Policy"). Scoped by `Filter.Prefix` to *only* `direct-uploads/`
 * (`temp-upload-cleanup.ts`'s own scope). Every permanent asset prefix has
 * no matching rule and is therefore never touched by this policy, by
 * construction — MinIO/S3 lifecycle expiration only ever applies to objects
 * matching a rule's prefix filter.
 *
 * `prepared-imports/` is deliberately EXCLUDED from this policy, even though
 * `temp-upload-cleanup.ts` treats it as a staging prefix too: publishing a
 * local-folder import never renames the object, so a committed Asset's
 * `storageKey` keeps living under `prepared-imports/` *forever* (see that
 * module's own doc comment). An unconditional, database-blind age-based
 * MinIO rule cannot tell a merely-old committed asset from an abandoned
 * staging object -- it silently deleted 490+ live, referenced assets across
 * 37 datasets before this was caught (the object age alone crossed 7 days;
 * the Postgres `Asset` row was never consulted, and MinIO has no way to
 * consult it). `direct-uploads/` has no such risk: no durable Asset ever
 * references that prefix (verified: 0 rows), so age-based expiration there
 * is safe exactly as originally intended -- catching what the reference-
 * aware `temp-upload-cleanup.ts` sweep (which *does* check the database)
 * might have missed, never deleting something still in use.
 *
 * Idempotent — matches `ensureBucket`'s pattern; setting the same
 * configuration again is a no-op change.
 */
export async function ensureTempUploadLifecyclePolicy(client: MinioClient, bucket: string, expirationDays: number) {
  await client.setBucketLifecycle(bucket, {
    Rule: [
      { ID: "annotationplatform-expire-direct-uploads", Status: "Enabled", Filter: { Prefix: "direct-uploads/" }, Expiration: { Days: expirationDays } },
    ],
  });
}
