import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

export type PrivateObjectStore = {
  statObject(bucket: string, objectKey: string): Promise<{ size: number }>;
  getObject(bucket: string, objectKey: string): Promise<NodeJS.ReadableStream>;
};

export type MaterializePrivateSourceResult =
  | { kind: "materialized"; path: string; sizeBytes: number }
  | { kind: "missing" }
  | { kind: "policy_rejected" }
  | { kind: "failed" };

/**
 * Materializes one private MinIO object to a job-owned path. Object identity
 * is resolved by the worker from PostgreSQL; no caller-provided storage key is
 * accepted by this helper's public scheduling boundary.
 */
export async function materializePrivateSource(input: {
  minio: PrivateObjectStore;
  bucket: string;
  objectKey: string;
  destinationPath: string;
  expectedSizeBytes: bigint | null;
  maxSourceBytes: bigint;
}): Promise<MaterializePrivateSourceResult> {
  let stat: { size: number };
  try {
    stat = await input.minio.statObject(input.bucket, input.objectKey);
  } catch {
    return { kind: "missing" };
  }
  const sizeBytes = BigInt(stat.size);
  if (sizeBytes < BigInt(0) || sizeBytes > input.maxSourceBytes || (input.expectedSizeBytes !== null && sizeBytes !== input.expectedSizeBytes)) {
    return { kind: "policy_rejected" };
  }
  try {
    await mkdir(dirname(input.destinationPath), { recursive: true });
    const source = await input.minio.getObject(input.bucket, input.objectKey);
    await pipeline(source, createWriteStream(input.destinationPath, { flags: "wx" }));
    return { kind: "materialized", path: input.destinationPath, sizeBytes: stat.size };
  } catch {
    return { kind: "failed" };
  }
}
