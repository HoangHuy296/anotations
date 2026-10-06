import "server-only";
import { createHash } from "node:crypto";
import { Client as MinioClient } from "minio";
import type { ObjectObservation, StatObject } from "./modality-backfill-evidence";

/**
 * Storage adapter for T029/T031: the ONE implementation of `StatObject` used by both the maintenance launcher and the disposable rehearsal.
 * It performs metadata-only reads (bucket existence, HEAD/stat of an object); it never reads, lists, writes or deletes object bytes.
 *
 * Consistency: object-store metadata is NOT transactionally locked with PostgreSQL. A stat answers "what the object looked like at that
 * instant". T031 therefore re-stats immediately before the assignment transaction and again compares everything inside the Serializable
 * transaction against PostgreSQL; an object changed between that last stat and the commit is outside what this protocol can detect and is
 * covered only by the writers being stopped for the maintenance window (see release/t029-t031-launcher.md).
 */
export type StorageConfig = { endpoint: string; accessKey: string; secretKey: string; region?: string };
export type StatClient = {
  statObject(bucket: string, key: string): Promise<{ size: number; etag?: string }>;
  bucketExists(bucket: string): Promise<boolean>;
};
const NOT_FOUND = new Set(["NotFound", "NoSuchKey", "NoSuchObject"]);
export const STAT_TIMEOUT_MS = 15_000;

export function createStorageClient(config: StorageConfig): StatClient {
  const endpoint = new URL(config.endpoint);
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.pathname !== "/" && endpoint.pathname !== "")) throw new Error("STORAGE_ENDPOINT_INVALID");
  return new MinioClient({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    useSSL: endpoint.protocol === "https:",
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    region: config.region ?? "us-east-1", // a fixed region avoids any region-discovery request
  });
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("STORAGE_TIMEOUT")), ms); });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * `null` means the object does not exist (NotFound/NoSuchKey). A missing BUCKET, a refused connection, a timeout, an authorization failure or
 * any other error is thrown, so the caller reports `OBJECT_CHECK_FAILED` instead of mistaking an unavailable store for a missing object.
 */
export function createMinioStatObject(client: StatClient, timeoutMs = STAT_TIMEOUT_MS): StatObject {
  return async (bucket, key) => {
    try {
      const stat = await withTimeout(client.statObject(bucket, key), timeoutMs);
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error("STORAGE_STAT_INVALID");
      const observation: ObjectObservation = { size: BigInt(stat.size), etag: typeof stat.etag === "string" && stat.etag ? stat.etag : null };
      return observation;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && NOT_FOUND.has(code)) return null;
      throw error;
    }
  };
}

export type StorageIdentity = { endpointHost: string; endpointPort: number; useSSL: boolean; bucket: string; bucketExists: boolean; configFingerprint: string };
/** Identity of the storage target WITHOUT secrets: where it is, which bucket, whether the bucket answers, and a fingerprint of the non-secret configuration plus a hash of the access-key id. */
export async function describeStorage(config: StorageConfig, bucket: string, client: StatClient = createStorageClient(config)): Promise<StorageIdentity> {
  const endpoint = new URL(config.endpoint);
  const useSSL = endpoint.protocol === "https:";
  const port = Number(endpoint.port || (useSSL ? 443 : 80));
  const bucketExists = await withTimeout(client.bucketExists(bucket), STAT_TIMEOUT_MS);
  const configFingerprint = createHash("sha256").update(JSON.stringify({ host: endpoint.hostname, port, useSSL, bucket, region: config.region ?? "us-east-1", accessKeyId: createHash("sha256").update(config.accessKey).digest("hex") })).digest("hex");
  return { endpointHost: endpoint.hostname, endpointPort: port, useSSL, bucket, bucketExists, configFingerprint };
}
