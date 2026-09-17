import "server-only";

import { createHash } from "node:crypto";
import { textBoundaryArtifactSchema, type TextBoundaryArtifact } from "@annotationplatform/domain/text-boundary-contract";

import { getWebProviders } from "@/lib/providers";

/**
 * Loads and validates the private grapheme-boundary derivative the worker
 * wrote for a prepared TEXT source. Every call — cache hit included — only
 * ever returns an artifact matching the exact `sourceIdentity`/
 * `boundaryArtifactDigest`/profile the caller supplies, which the caller
 * (text-source-read-service.ts, T028) has already re-authorized and
 * re-verified against current durable metadata immediately before calling
 * this. The cache therefore never bypasses that check — it only avoids
 * re-fetching and re-parsing immutable, digest-addressed bytes from MinIO.
 * Uses the real private MinIO client from providers.ts; never the local-file
 * StorageProvider fallback, and never returns/logs the storage key.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024; // grapheme boundary maps are small JSON; generous, still bounded.

type CacheEntry = { artifact: TextBoundaryArtifact; expiresAt: number };

const cache = new Map<string, CacheEntry>();

function cacheKey(input: LoadTextBoundaryInput): string {
  return [
    input.datasetId,
    input.assetId,
    input.sourceIdentity,
    input.boundaryArtifactDigest,
    input.boundaryProfile.algorithm,
    input.boundaryProfile.schemaVersion,
  ].join("::");
}

function pruneExpired(now: number) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

function evictOldestIfFull() {
  if (cache.size < CACHE_MAX_ENTRIES) return;
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) cache.delete(oldestKey);
}

async function readBoundedStreamToBuffer(stream: NodeJS.ReadableStream, maxBytes: number): Promise<{ kind: "complete"; bytes: Buffer } | { kind: "oversized" }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      const destroyable = stream as Partial<{ destroy: (error?: Error) => void }>;
      destroyable.destroy?.();
      return { kind: "oversized" };
    }
    chunks.push(bytes);
  }
  return { kind: "complete", bytes: Buffer.concat(chunks) };
}

export type LoadTextBoundaryInput = {
  datasetId: string;
  assetId: string;
  storageBucket: string;
  boundaryArtifactKey: string;
  boundaryArtifactDigest: string;
  sourceIdentity: string;
  offsetUnit: string;
  sourceCodeUnitLength: number;
  boundaryProfile: { algorithm: string; schemaVersion: number };
};

export type LoadTextBoundaryResult =
  | { kind: "loaded"; artifact: TextBoundaryArtifact }
  | { kind: "missing" }
  | { kind: "oversized" }
  | { kind: "digest_mismatch" }
  | { kind: "schema_invalid" }
  | { kind: "identity_mismatch" };

export async function loadVerifiedTextBoundaryArtifact(input: LoadTextBoundaryInput): Promise<LoadTextBoundaryResult> {
  const now = Date.now();
  pruneExpired(now);
  const key = cacheKey(input);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    // Re-insert to mark most-recently-used for the bounded LRU.
    cache.delete(key);
    cache.set(key, cached);
    return { kind: "loaded", artifact: cached.artifact };
  }

  const { minio } = getWebProviders();
  let bytes: Buffer;
  try {
    const stream = await minio.getObject(input.storageBucket, input.boundaryArtifactKey);
    const read = await readBoundedStreamToBuffer(stream, MAX_ARTIFACT_BYTES);
    if (read.kind !== "complete") return { kind: "oversized" };
    bytes = read.bytes;
  } catch {
    return { kind: "missing" };
  }

  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== input.boundaryArtifactDigest) return { kind: "digest_mismatch" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { kind: "schema_invalid" };
  }
  const parsed = textBoundaryArtifactSchema.safeParse(parsedJson);
  if (!parsed.success) return { kind: "schema_invalid" };
  const artifact = parsed.data;

  if (
    artifact.sourceIdentity !== input.sourceIdentity ||
    artifact.offsetUnit !== input.offsetUnit ||
    artifact.sourceCodeUnitLength !== input.sourceCodeUnitLength ||
    artifact.profile.algorithm !== input.boundaryProfile.algorithm ||
    artifact.profile.schemaVersion !== input.boundaryProfile.schemaVersion
  ) {
    return { kind: "identity_mismatch" };
  }

  evictOldestIfFull();
  cache.set(key, { artifact, expiresAt: now + CACHE_TTL_MS });
  return { kind: "loaded", artifact };
}

/** Test-only: clears the module-level cache between isolated test runs. */
export function __resetTextBoundaryCacheForTests() {
  cache.clear();
}
