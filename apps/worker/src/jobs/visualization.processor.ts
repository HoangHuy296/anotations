import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "minio";
import { Prisma, type PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { artifactIdentity, canonicalCapturedContent, canonicalJson, captureIdentity, deriveVisualizationProfile, sha256, snapshotDescriptorSchema, visualizationCaptureInputSchema, visualizationDeriveInputSchema, VISUALIZATION_CAPTURE_ALGORITHM, VISUALIZATION_LIMITS, VISUALIZATION_PREVIEW_ALGORITHM, VISUALIZATION_PROFILE_ALGORITHM, type CapturedContent, type SnapshotDescriptor, type VisualizationArtifactKind } from "@annotationplatform/domain/visualization-processing";
import { getWorkerConfig } from "../config.js";
import { createWorkerMinio } from "../providers/minio.js";
import { heartbeatJob, failJob, cancelJob } from "./job-claim-lock.js";
import { runBoundedMediaProcess } from "../media/subprocess.js";

export type PublishedArtifact = { id: string; datasetId: string; snapshotId: string; kind: string; algorithm: string; scope: string; bucket: string; key: string; sha256: string; sizeBytes: bigint; contentType: string };
class StaleCapture extends Error {}
const live = { deletedAt: null, archivedAt: null };
const raster = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

export async function boundedObject(minio: Client, bucket: string, key: string, limit: number) {
  const stat = await minio.statObject(bucket, key);
  if (stat.size > limit) throw new Error("Artifact exceeds limit");
  const stream = await minio.getObject(bucket, key);
  const chunks: Buffer[] = []; let size = 0;
  try { for await (const chunk of stream) { size += chunk.length; if (size > limit) throw new Error("Artifact exceeds limit"); chunks.push(Buffer.from(chunk)); } }
  finally { stream.destroy(); }
  const after = await minio.statObject(bucket, key);
  if (stat.etag !== after.etag || stat.size !== size) throw new StaleCapture();
  return Buffer.concat(chunks);
}

/** One MVCC capture; no binary I/O or generation writes inside the read transaction. */
export async function readCapture(db: PrismaClient, datasetId: string, generation: bigint) {
  return db.$transaction(async tx => {
    const dataset = await tx.dataset.findFirst({ where: { id: datasetId, ...live, visualizationGeneration: generation, metadata: { path: ["workflowStatus"], equals: "COMPLETED" } }, select: { id: true, name: true, description: true } });
    if (!dataset) throw new StaleCapture();
    const assets = await tx.asset.findMany({ where: { datasetId, ...live }, orderBy: { id: "asc" }, take: VISUALIZATION_LIMITS.assets + 1, select: { id: true, filename: true, modality: true, mimeType: true, width: true, height: true, sizeBytes: true, storageProvider: true, storageBucket: true, storageKey: true, checksum: true, sourceFingerprint: true } });
    const annotations = await tx.annotation.findMany({ where: { datasetId, asset: { ...live } }, orderBy: { id: "asc" }, take: VISUALIZATION_LIMITS.annotations + 1, select: { id: true, assetId: true, labelId: true, type: true, modality: true, geometry: true, revision: true, status: true, source: true } });
    const labels = await tx.label.findMany({ where: { datasetId }, orderBy: { id: "asc" }, take: VISUALIZATION_LIMITS.labels + 1, select: { id: true, name: true, color: true, modality: true, scope: true, description: true } });
    if (assets.length > VISUALIZATION_LIMITS.assets || annotations.length > VISUALIZATION_LIMITS.annotations || labels.length > VISUALIZATION_LIMITS.labels) throw new Error("Capture exceeds limit");
    return { dataset, assets, labels, annotations };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30000 });
}

/** Deterministic logical identity, content-addressed physical bytes. No ready object is overwritten. */
async function putArtifact(db: PrismaClient, minio: Client, bucket: string, context: { datasetId: string; snapshotId: string; generation: string }, kind: VisualizationArtifactKind, algorithm: string, scope: string, bytes: Buffer, contentType: string): Promise<PublishedArtifact> {
  const id = artifactIdentity({ ...context, kind, algorithm, scope });
  const digest = sha256(bytes);
  const existing = await db.visualizationArtifact.findUnique({ where: { id } });
  if (existing) {
    const verified = await boundedObject(minio, existing.bucket, existing.key, Math.max(VISUALIZATION_LIMITS.descriptorBytes, VISUALIZATION_LIMITS.sourceBytes));
    if (sha256(verified) !== existing.sha256) throw new Error("Published artifact unavailable");
    return existing;
  }
  const key = `visualization/${context.datasetId}/${context.snapshotId}/${id}/${digest}`;
  await minio.putObject(bucket, key, bytes, bytes.length, { "Content-Type": contentType });
  return { id, datasetId: context.datasetId, snapshotId: context.snapshotId, kind, algorithm, scope, bucket, key, sha256: digest, sizeBytes: BigInt(bytes.length), contentType };
}

/** Shared writer fence: source triggers acquire the same parent row lock. */
export async function publishVisualization(db: PrismaClient, input: { jobId: string; lockToken: string; datasetId: string; generation: bigint; descriptor?: SnapshotDescriptor; snapshotId: string; artifacts: PublishedArtifact[] }) {
  return db.$transaction(async tx => {
    const fence = await tx.dataset.updateMany({ where: { id: input.datasetId, ...live, visualizationGeneration: input.generation, metadata: { path: ["workflowStatus"], equals: "COMPLETED" }, ...(!input.descriptor ? { visualizationCurrentSnapshotId: input.snapshotId } : {}) }, data: { visualizationPublicationFence: { increment: 1 } } });
    if (!fence.count) throw new StaleCapture();
    const claimed = await tx.job.updateMany({ where: { id: input.jobId, datasetId: input.datasetId, lockToken: input.lockToken, status: "RUNNING", cancelRequestedAt: null, lockedUntil: { gt: new Date() } }, data: { status: "COMPLETED", stage: "FINISHED", progress: 100, finishedAt: new Date(), lockToken: null, lockedBy: null, lockedUntil: null, lockedAt: null, heartbeatAt: null, summary: { message: input.descriptor ? "Immutable snapshot published." : "Snapshot artifacts published." } } });
    if (!claimed.count) throw new StaleCapture();
    if (input.descriptor) {
      const prior = await tx.datasetSnapshot.findUnique({ where: { id: input.snapshotId } });
      if (!prior) {
        const ordinal = (await tx.datasetSnapshot.aggregate({ where: { datasetId: input.datasetId }, _max: { ordinal: true } }))._max.ordinal ?? 0;
        await tx.datasetSnapshot.create({ data: { id: input.snapshotId, datasetId: input.datasetId, generation: input.generation, contentDigest: input.descriptor.contentDigest, algorithm: input.descriptor.algorithm, ordinal: ordinal + 1, assetCount: input.descriptor.content.assets.length, annotationCount: input.descriptor.content.annotations.length } });
      }
      await tx.dataset.update({ where: { id: input.datasetId }, data: { visualizationCurrentSnapshotId: input.snapshotId } });
    }
    for (const artifact of input.artifacts) {
      if (artifact.datasetId !== input.datasetId || artifact.snapshotId !== input.snapshotId) throw new Error("Artifact scope mismatch");
      // Never upsert an immutable reference (even an empty update triggers immutability).
      if (!await tx.visualizationArtifact.findUnique({ where: { id: artifact.id }, select: { id: true } })) await tx.visualizationArtifact.create({ data: artifact });
    }
    if (input.descriptor) {
      const key = `visualization:derive:${input.snapshotId}:${VISUALIZATION_PROFILE_ALGORITHM}:${VISUALIZATION_PREVIEW_ALGORITHM}`;
      if (!await tx.job.findFirst({ where: { datasetId: input.datasetId, idempotencyKey: key }, select: { id: true } })) {
        const original = await tx.job.findUniqueOrThrow({ where: { id: input.jobId }, select: { createdById: true } });
        await tx.job.create({ data: { datasetId: input.datasetId, createdById: original.createdById, type: "VISUALIZATION_DERIVE", idempotencyKey: key, input: { generation: input.generation.toString(), snapshotId: input.snapshotId, profileAlgorithm: VISUALIZATION_PROFILE_ALGORITHM, previewAlgorithm: VISUALIZATION_PREVIEW_ALGORITHM } } });
      }
    }
    await tx.jobEvent.create({ data: { jobId: input.jobId, level: "INFO", message: input.descriptor ? "Snapshot published." : "Snapshot profiles and previews published." } });
  }, { timeout: 30000 });
}

export async function processVisualization(db: PrismaClient, jobId: string, lockToken: string, hooks: { beforePublish?: () => Promise<void>; render?: typeof renderImage } = {}) {
  const job = await db.job.findFirst({ where: { id: jobId, lockToken, status: "RUNNING", type: { in: ["VISUALIZATION_CAPTURE", "VISUALIZATION_DERIVE"] } } });
  if (!job) return "refused";
  const config = getWorkerConfig(); const minio = createWorkerMinio(config);
  let directory: string | undefined;
  const keepLease = async () => { if ((await heartbeatJob(db, { jobId, lockToken })).kind !== "updated") throw new StaleCapture(); };
  const timer = setInterval(() => { void keepLease().catch(() => {}); }, 30000); timer.unref();
  try {
    const artifacts: PublishedArtifact[] = [];
    let descriptor: SnapshotDescriptor;
    if (job.type === "VISUALIZATION_CAPTURE") {
      const input = visualizationCaptureInputSchema.parse(job.input);
      const captured = await readCapture(db, job.datasetId, BigInt(input.generation));
      const sources = new Map<string, Buffer>(); let total = 0;
      const content: CapturedContent = { dataset: captured.dataset, labels: captured.labels, annotations: captured.annotations as CapturedContent["annotations"], assets: [] };
      for (const asset of captured.assets) {
        let bytes: Buffer | undefined;
        if (asset.modality === "IMAGE") {
          if (!raster.has(asset.mimeType) || asset.storageProvider !== "MINIO" || !asset.storageBucket || !asset.storageKey) throw new Error("Image source unavailable for immutable capture");
          bytes = await boundedObject(minio, asset.storageBucket, asset.storageKey, VISUALIZATION_LIMITS.sourceBytes);
          total += bytes.length; if (total > VISUALIZATION_LIMITS.totalSourceBytes) throw new Error("Capture exceeds source limit");
          sources.set(asset.id, bytes);
        }
        content.assets.push({ id: asset.id, filename: asset.filename, modality: asset.modality, mimeType: asset.mimeType, width: asset.width, height: asset.height,
          sourceIdentity: sha256(canonicalJson({ storageProvider: asset.storageProvider, storageBucket: asset.storageBucket, storageKey: asset.storageKey, checksum: asset.checksum, fingerprint: asset.sourceFingerprint, sizeBytes: asset.sizeBytes?.toString() ?? null })), sourceSha256: bytes ? sha256(bytes) : null, sourceBytes: bytes?.length ?? null });
        await keepLease();
      }
      const canonical = canonicalCapturedContent(content);
      const identity = captureIdentity(job.datasetId, input.generation, canonical);
      descriptor = { schemaVersion: 1, ...identity, generation: input.generation, algorithm: VISUALIZATION_CAPTURE_ALGORITHM, content: canonical };
      const context = { datasetId: job.datasetId, snapshotId: descriptor.snapshotId, generation: input.generation };
      for (const asset of content.assets) { const bytes = sources.get(asset.id); if (bytes) artifacts.push(await putArtifact(db, minio, config.MINIO_BUCKET, context, "SOURCE_IMAGE", VISUALIZATION_CAPTURE_ALGORITHM, asset.id, bytes, asset.mimeType)); }
      const body = Buffer.from(canonicalJson(descriptor));
      if (body.length > VISUALIZATION_LIMITS.descriptorBytes) throw new Error("Capture descriptor exceeds limit");
      artifacts.push(await putArtifact(db, minio, config.MINIO_BUCKET, context, "CAPTURE", VISUALIZATION_CAPTURE_ALGORITHM, "dataset", body, "application/json"));
      await hooks.beforePublish?.();
      await publishVisualization(db, { jobId, lockToken, ...context, generation: BigInt(input.generation), descriptor, artifacts });
    } else {
      const input = visualizationDeriveInputSchema.parse(job.input);
      const snapshot = await db.datasetSnapshot.findFirst({ where: { id: input.snapshotId, datasetId: job.datasetId, generation: BigInt(input.generation) } });
      const capture = await db.visualizationArtifact.findFirst({ where: { datasetId: job.datasetId, snapshotId: input.snapshotId, kind: "CAPTURE", algorithm: VISUALIZATION_CAPTURE_ALGORITHM } });
      if (!snapshot || !capture) throw new Error("Snapshot unavailable");
      const body = await boundedObject(minio, capture.bucket, capture.key, VISUALIZATION_LIMITS.descriptorBytes);
      if (sha256(body) !== capture.sha256) throw new Error("Capture checksum mismatch");
      descriptor = snapshotDescriptorSchema.parse(JSON.parse(body.toString()));
      const context = { datasetId: job.datasetId, snapshotId: snapshot.id, generation: input.generation };
      if (descriptor.snapshotId !== snapshot.id || descriptor.content.dataset.id !== job.datasetId || descriptor.generation !== input.generation || descriptor.contentDigest !== snapshot.contentDigest || captureIdentity(job.datasetId, input.generation, descriptor.content).snapshotId !== snapshot.id) throw new Error("Capture scope mismatch");
      const profile = Buffer.from(JSON.stringify(deriveVisualizationProfile(descriptor.content)));
      if (profile.length > VISUALIZATION_LIMITS.profileBytes) throw new Error("Profile exceeds limit");
      artifacts.push(await putArtifact(db, minio, config.MINIO_BUCKET, context, "PROFILE", input.profileAlgorithm, "dataset", profile, "application/json"));
      directory = await mkdtemp(join(tmpdir(), "visualization-"));
      for (const asset of descriptor.content.assets.filter(a => a.modality === "IMAGE")) {
        const source = await db.visualizationArtifact.findFirst({ where: { datasetId: job.datasetId, snapshotId: snapshot.id, kind: "SOURCE_IMAGE", scope: asset.id } });
        if (!source) throw new Error("Captured source unavailable");
        const bytes = await boundedObject(minio, source.bucket, source.key, VISUALIZATION_LIMITS.sourceBytes);
        if (sha256(bytes) !== source.sha256) throw new Error("Captured source checksum mismatch");
        for (const kind of ["THUMBNAIL", "PREVIEW"] as const) {
          const output = await (hooks.render ?? renderImage)(bytes, directory, kind === "THUMBNAIL" ? 480 : 1600);
          artifacts.push(await putArtifact(db, minio, config.MINIO_BUCKET, context, kind, input.previewAlgorithm, asset.id, output, "image/webp"));
        }
        await keepLease();
      }
      await hooks.beforePublish?.();
      await publishVisualization(db, { jobId, lockToken, ...context, generation: BigInt(input.generation), artifacts });
    }
    return "completed";
  } catch (error) {
    const canceled = await db.job.findFirst({ where: { id: jobId, lockToken, OR: [{ cancelRequestedAt: { not: null } }, { status: "CANCELING" }] }, select: { id: true } });
    if (canceled) await cancelJob(db, { jobId, lockToken });
    else {
      await db.job.updateMany({ where: { id: jobId, lockToken, status: "RUNNING" }, data: { errorCode: error instanceof StaleCapture ? "VISUALIZATION_STALE_GENERATION" : "VISUALIZATION_PROCESSING_FAILED", error: "Visualization processing could not publish a result." } });
      await failJob(db, { jobId, lockToken });
    }
    // Unpublished deterministic objects are collected by reference-aware GC after its grace period.
    return "failed";
  } finally { clearInterval(timer); if (directory) await rm(directory, { recursive: true, force: true }); }
}

export async function renderImage(bytes: Buffer, directory: string, maxDimension: number) {
  const input = join(directory, "source"); const output = join(directory, "preview.webp");
  await writeFile(input, bytes);
  const result = await runBoundedMediaProcess({ command: "ffmpeg", args: ["-nostdin", "-v", "error", "-y", "-threads", "1", "-i", input, "-frames:v", "1", "-vf", `scale=w='min(${maxDimension},iw)':h='min(${maxDimension},ih)':force_original_aspect_ratio=decrease`, "-c:v", "libwebp", "-quality", "80", output], cwd: directory, timeoutMs: 30000, maxOutputBytes: 1024 * 1024 });
  if (result.kind !== "completed") throw new Error("Image preview unavailable");
  const body = await readFile(output); if (body.length > 5 * 1024 * 1024) throw new Error("Preview exceeds limit");
  return body;
}
