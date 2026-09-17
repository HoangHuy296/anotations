import "server-only";

import { createHash } from "node:crypto";
import { Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { getWebProviders } from "@/lib/providers";
import { getTextSourceLimits } from "@/lib/config/text-source-limits";
import { decodeUtf8SourceBytes, TextSourceDecodeError } from "@annotationplatform/domain/text-source-decode";
import { UTF16_CODE_UNIT } from "@annotationplatform/domain/text-annotation-contract";
import { loadVerifiedTextBoundaryArtifact } from "@/lib/annotations/text-boundary-loader";
import { deriveTextSourceReadiness, type TextSourceReadiness, type TextSourceReverification } from "@/lib/annotations/text-source-readiness";

/**
 * The single authoritative place TEXT source-authority logic lives (research.md
 * "Shared contracts and read-service boundary"). Both the GET source route
 * (T054) and mutation validation (US2's text-span-service.ts) must call this
 * — neither re-implements decode/identity/limit logic. No I/O happens inside
 * an annotation mutation transaction: callers obtain this verified immutable
 * context *before* opening one, then recheck identity inside it.
 *
 * Every call re-verifies the object's raw bytes against the durable
 * `sourceIdentity`/lengths even when previously READY, so a source silently
 * replaced after preparation degrades to SOURCE_MISMATCH instead of serving
 * stale offsets against new content.
 */

function boundaryProfileFields(value: unknown): { algorithm: string; schemaVersion: number } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.algorithm === "string" && typeof candidate.schemaVersion === "number") {
    return { algorithm: candidate.algorithm, schemaVersion: candidate.schemaVersion };
  }
  return null;
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

export type TextSourceReadOutcome =
  | {
      ok: true;
      readiness: "READY";
      assetId: string;
      datasetId: string;
      sourceIdentity: string;
      offsetUnit: "UTF16_CODE_UNIT";
      sourceByteLength: number;
      sourceCodeUnitLength: number;
      text: string;
      boundaryOffsets: readonly number[];
    }
  | { ok: true; readiness: Exclude<TextSourceReadiness, "READY">; assetId: string; datasetId: string }
  | { ok: false; reason: "NOT_FOUND" };

export async function readTextSource(actor: RequestActor, assetId: string): Promise<TextSourceReadOutcome> {
  const asset = await db.asset.findFirst({
    where: { id: assetId, deletedAt: null, archivedAt: null, modality: Modality.TEXT },
    select: {
      id: true,
      datasetId: true,
      storageBucket: true,
      storageKey: true,
      textAsset: {
        select: {
          sourceIdentity: true,
          sourceCodeUnitLength: true,
          sourceByteLength: true,
          boundaryArtifactKey: true,
          boundaryArtifactDigest: true,
          boundaryProfile: true,
          content: true,
        },
      },
    },
  });
  if (!asset) return { ok: false, reason: "NOT_FOUND" };

  const access = await requireDatasetPermission(actor, asset.datasetId, "dataset.read");
  if (!access || access.forbidden) return { ok: false, reason: "NOT_FOUND" };

  const latestPrepareJob = await db.job.findFirst({
    where: { datasetId: asset.datasetId, type: "TEXT_SOURCE_PREPARE", input: { path: ["assetId"], equals: assetId } },
    orderBy: { createdAt: "desc" },
    select: { status: true, errorCode: true },
  });

  const resolvedAssetId = asset.id;
  const resolvedDatasetId = asset.datasetId;
  const textAssetForReadiness = asset.textAsset ? { sourceIdentity: asset.textAsset.sourceIdentity, content: asset.textAsset.content } : null;
  const assetForReadiness = { storageBucket: asset.storageBucket, storageKey: asset.storageKey };

  function unready(reverification?: TextSourceReverification) {
    const readiness = deriveTextSourceReadiness({ asset: assetForReadiness, textAsset: textAssetForReadiness, latestPrepareJob, reverification });
    return { ok: true as const, readiness: readiness as Exclude<TextSourceReadiness, "READY">, assetId: resolvedAssetId, datasetId: resolvedDatasetId };
  }

  if (!asset.textAsset?.sourceIdentity) return unready();
  const textAsset = asset.textAsset;
  if (!asset.storageBucket || !asset.storageKey) return unready({ kind: "unavailable" });

  const limits = getTextSourceLimits();
  const { config, minio } = getWebProviders();

  let bytes: Buffer;
  try {
    const stat = await minio.statObject(asset.storageBucket, asset.storageKey);
    if (stat.size > limits.maxSourceBytes) return unready({ kind: "oversized" });
    const stream = await minio.getObject(asset.storageBucket, asset.storageKey);
    const read = await readBoundedStreamToBuffer(stream, limits.maxSourceBytes);
    if (read.kind !== "complete") return unready({ kind: "oversized" });
    bytes = read.bytes;
  } catch {
    return unready({ kind: "unavailable" });
  }

  const rawDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (rawDigest !== textAsset.sourceIdentity) return unready({ kind: "mismatch" });

  let decoded: ReturnType<typeof decodeUtf8SourceBytes>;
  try {
    decoded = decodeUtf8SourceBytes(bytes);
  } catch (error) {
    if (error instanceof TextSourceDecodeError) return unready({ kind: "invalid_encoding" });
    throw error;
  }
  if (decoded.codeUnitLength !== textAsset.sourceCodeUnitLength || decoded.byteLength !== textAsset.sourceByteLength) {
    return unready({ kind: "mismatch" });
  }

  const profileFields = boundaryProfileFields(textAsset.boundaryProfile);
  if (!textAsset.boundaryArtifactKey || !textAsset.boundaryArtifactDigest || !profileFields) return unready({ kind: "unavailable" });

  const boundary = await loadVerifiedTextBoundaryArtifact({
    datasetId: asset.datasetId,
    assetId: asset.id,
    storageBucket: config.MINIO_BUCKET,
    boundaryArtifactKey: textAsset.boundaryArtifactKey,
    boundaryArtifactDigest: textAsset.boundaryArtifactDigest,
    sourceIdentity: textAsset.sourceIdentity,
    offsetUnit: UTF16_CODE_UNIT,
    sourceCodeUnitLength: decoded.codeUnitLength,
    boundaryProfile: profileFields,
  });
  if (boundary.kind !== "loaded") return unready({ kind: "unavailable" });

  return {
    ok: true,
    readiness: "READY",
    assetId: asset.id,
    datasetId: asset.datasetId,
    sourceIdentity: textAsset.sourceIdentity,
    offsetUnit: UTF16_CODE_UNIT,
    sourceByteLength: decoded.byteLength,
    sourceCodeUnitLength: decoded.codeUnitLength,
    text: decoded.text,
    boundaryOffsets: boundary.artifact.boundaryOffsets,
  };
}
