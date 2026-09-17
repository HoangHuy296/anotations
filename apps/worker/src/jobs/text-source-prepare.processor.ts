import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { textSourcePrepareJobInputSchema } from "@annotationplatform/domain/text-source-prepare-job";
import { createWorkerMinio } from "../providers/minio.js";
import { getWorkerConfig, getTextSourceLimits } from "../config.js";
import { verifyTextSourceBytes, readBoundedStreamToBuffer } from "../source/text-source-verify.js";
import { computeTextBoundaryArtifact, textBoundaryArtifactObjectKey } from "../source/text-boundary.js";
import { safeCleanupTextBoundaryArtifact } from "../source/text-boundary-derivative.js";
import { cancelJob, completeJob, failJob, heartbeatJob, updateJobProgress } from "./job-claim-lock.js";

export type TextSourcePrepareResult = "completed" | "canceled" | "failed" | "refused";

async function canceled(db: PrismaClient, jobId: string, lockToken: string) {
  const job = await db.job.findFirst({ where: { id: jobId, lockToken, status: { in: ["RUNNING", "CANCELING"] } }, select: { cancelRequestedAt: true, status: true } });
  return Boolean(job?.cancelRequestedAt || job?.status === "CANCELING");
}

function sourceIdentityMatches(
  asset: { storageBucket: string | null; storageKey: string | null; checksum: string | null; sizeBytes: bigint | null },
  expected: { storageBucket: string; storageKey: string; checksum: string | null; sizeBytes: string | null },
) {
  return (
    asset.storageBucket === expected.storageBucket &&
    asset.storageKey === expected.storageKey &&
    asset.checksum === expected.checksum &&
    (asset.sizeBytes === null ? expected.sizeBytes === null : asset.sizeBytes.toString() === expected.sizeBytes)
  );
}

/**
 * Claim/attempt/terminal-state via the existing Job lifecycle. Rechecks
 * source metadata identity twice — once before doing any work, once again at
 * commit — so a source replaced mid-preparation is rejected rather than
 * silently bound to stale offsets (data-model.md "Source document"). Leaves
 * TextAsset unchanged on any failure.
 */
export async function processTextSourcePrepare(db: PrismaClient, jobId: string, lockToken: string): Promise<TextSourcePrepareResult> {
  const job = await db.job.findFirst({ where: { id: jobId, type: "TEXT_SOURCE_PREPARE", lockToken, status: { in: ["RUNNING", "CANCELING"] } }, select: { id: true, datasetId: true, input: true } });
  if (!job) return "refused";

  const input = textSourcePrepareJobInputSchema.safeParse(job.input);
  if (!input.success || input.data.datasetId !== job.datasetId) {
    await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode: "TEXT_SOURCE_MISSING" } });
    await failJob(db, { jobId, lockToken });
    return "failed";
  }

  const asset = await db.asset.findFirst({
    where: { id: input.data.assetId, datasetId: job.datasetId, modality: "TEXT", deletedAt: null, archivedAt: null },
    select: { id: true, storageBucket: true, storageKey: true, checksum: true, sizeBytes: true, sourceFingerprint: true },
  });
  if (!asset?.storageBucket || !asset.storageKey || !sourceIdentityMatches(asset, input.data.expectedSource)) {
    await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode: "TEXT_SOURCE_STALE" } });
    await failJob(db, { jobId, lockToken });
    return "failed";
  }

  if ((await updateJobProgress(db, { jobId, lockToken, stage: "VALIDATING_INPUT", progress: 1, totalItems: 1, processedItems: 0, successItems: 0, failedItems: 0, skippedItems: 0 })).kind !== "updated") return "refused";

  const config = getWorkerConfig();
  const limits = getTextSourceLimits();
  const minio = createWorkerMinio(config);

  if (await canceled(db, job.id, lockToken)) return "canceled";

  let objectStream: NodeJS.ReadableStream;
  try {
    objectStream = await minio.getObject(asset.storageBucket, asset.storageKey);
  } catch {
    await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode: "TEXT_SOURCE_MISSING" } });
    await failJob(db, { jobId, lockToken });
    return "failed";
  }
  const read = await readBoundedStreamToBuffer(objectStream, limits.maxSourceBytes);
  if (read.kind !== "complete") {
    await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode: "TEXT_SOURCE_OVERSIZED_BYTES" } });
    await failJob(db, { jobId, lockToken });
    return "failed";
  }
  await heartbeatJob(db, { jobId, lockToken });

  const verified = verifyTextSourceBytes(read.bytes, limits);
  if (verified.kind !== "verified") {
    const errorCode = verified.kind === "invalid_encoding" ? "TEXT_SOURCE_INVALID_ENCODING" : verified.kind === "oversized_bytes" ? "TEXT_SOURCE_OVERSIZED_BYTES" : "TEXT_SOURCE_OVERSIZED_CODE_UNITS";
    await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode } });
    await failJob(db, { jobId, lockToken });
    return "failed";
  }

  if ((await updateJobProgress(db, { jobId, lockToken, stage: "EXTRACTING_METADATA", progress: 40, totalItems: 1, processedItems: 0, successItems: 0, failedItems: 0, skippedItems: 0 })).kind !== "updated") return "refused";
  if (await canceled(db, job.id, lockToken)) return "canceled";

  const artifact = computeTextBoundaryArtifact({ text: verified.text, sourceIdentity: verified.sourceIdentity });
  const artifactKey = textBoundaryArtifactObjectKey({ datasetId: job.datasetId, assetId: asset.id, sourceIdentity: verified.sourceIdentity });
  const artifactBytes = Buffer.from(JSON.stringify(artifact), "utf8");
  const { createHash } = await import("node:crypto");
  const artifactDigest = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;

  let uploaded = false;
  try {
    if ((await updateJobProgress(db, { jobId, lockToken, stage: "UPLOADING_OBJECTS", progress: 70, totalItems: 1, processedItems: 0, successItems: 0, failedItems: 0, skippedItems: 0 })).kind !== "updated") return "refused";
    await minio.putObject(config.MINIO_BUCKET, artifactKey, artifactBytes, artifactBytes.length, { "Content-Type": "application/json" });
    uploaded = true;

    if (await canceled(db, job.id, lockToken)) {
      await safeCleanupTextBoundaryArtifact(db, { bucket: config.MINIO_BUCKET, objectKey: artifactKey, assetId: asset.id });
      await cancelJob(db, { jobId, lockToken });
      return "canceled";
    }

    if ((await updateJobProgress(db, { jobId, lockToken, stage: "WRITING_METADATA", progress: 90, totalItems: 1, processedItems: 0, successItems: 0, failedItems: 0, skippedItems: 0 })).kind !== "updated") {
      await safeCleanupTextBoundaryArtifact(db, { bucket: config.MINIO_BUCKET, objectKey: artifactKey, assetId: asset.id });
      return "refused";
    }

    const reconciled = await db.$transaction(async (tx) => {
      const live = await tx.job.findFirst({ where: { id: jobId, lockToken, status: "RUNNING", lockedUntil: { gt: new Date() } }, select: { id: true } });
      if (!live) return false;
      // Recheck at commit: a source replaced mid-preparation must not bind stale offsets to it.
      const currentAsset = await tx.asset.findFirst({ where: { id: asset.id, datasetId: job.datasetId, modality: "TEXT", deletedAt: null, archivedAt: null }, select: { storageBucket: true, storageKey: true, checksum: true, sizeBytes: true, sourceFingerprint: true } });
      if (!currentAsset || !sourceIdentityMatches(currentAsset, input.data.expectedSource)) return false;
      await tx.textAsset.upsert({
        where: { assetId: asset.id },
        create: {
          assetId: asset.id,
          sourceIdentity: verified.sourceIdentity,
          sourceEncoding: "UTF8",
          offsetUnit: artifact.offsetUnit,
          sourceByteLength: verified.byteLength,
          sourceCodeUnitLength: verified.codeUnitLength,
          boundaryArtifactKey: artifactKey,
          boundaryArtifactDigest: artifactDigest,
          boundaryProfile: artifact.profile,
          preparedSourceFingerprint: currentAsset.sourceFingerprint,
          preparedAt: new Date(),
        },
        update: {
          sourceIdentity: verified.sourceIdentity,
          sourceEncoding: "UTF8",
          offsetUnit: artifact.offsetUnit,
          sourceByteLength: verified.byteLength,
          sourceCodeUnitLength: verified.codeUnitLength,
          boundaryArtifactKey: artifactKey,
          boundaryArtifactDigest: artifactDigest,
          boundaryProfile: artifact.profile,
          preparedSourceFingerprint: currentAsset.sourceFingerprint,
          preparedAt: new Date(),
        },
      });
      return true;
    });

    if (!reconciled) {
      await safeCleanupTextBoundaryArtifact(db, { bucket: config.MINIO_BUCKET, objectKey: artifactKey, assetId: asset.id });
      await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode: "TEXT_SOURCE_STALE" } });
      await failJob(db, { jobId, lockToken });
      return "failed";
    }

    const done = await completeJob(db, { jobId, lockToken, stage: "FINISHED", progress: 100, totalItems: 1, processedItems: 1, successItems: 1, failedItems: 0, skippedItems: 0, summary: { message: "TEXT source preparation completed.", outcome: "completed", resultCount: 1 } });
    return done.kind === "updated" ? "completed" : "refused";
  } catch {
    if (uploaded) await safeCleanupTextBoundaryArtifact(db, { bucket: config.MINIO_BUCKET, objectKey: artifactKey, assetId: asset.id });
    await failJob(db, { jobId, lockToken });
    return "failed";
  }
}
