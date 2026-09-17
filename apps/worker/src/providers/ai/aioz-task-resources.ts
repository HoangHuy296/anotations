import { z } from "zod";

import type { PrismaClient } from "../../../../../lib/generated/prisma/client.js";
import { getWorkerConfig } from "../../config.js";
import { createWorkerMinio } from "../minio.js";
import { POLL_BASE_DELAY_MS } from "../../jobs/ai-poll-constants.js";
import { AiozProviderError, digestAiozImageUrl, type AiozTaskResources } from "./aioz-annotation-services-provider.js";

const inputSchema = z.object({ confidence_threshold: z.number().min(0).max(1).optional(), iou_threshold: z.number().min(0).max(1).optional(), classes: z.array(z.string().min(1).max(256)).min(1).max(10000).optional(), assetIds: z.array(z.string().min(1)).min(1) });
const optionsSchema = z.object({
  classes: z.array(z.string().min(1)).optional(),
  confidence_threshold: z.number().min(0).max(1).optional(),
  iou_threshold: z.number().min(0).max(1).optional(),
}).strict();
const manifestSchema = z.object({ version: z.literal(1), phase: z.literal("SUBMITTING"), images: z.array(z.object({ assetId: z.string(), urlDigest: z.string().regex(/^[a-f0-9]{64}$/) })).min(1) });

export type AiozImageSigner = (bucket: string, key: string) => Promise<string>;

/** Sign against the configured externally reachable MinIO origin, never a rewritten signature. */
async function signImage(bucket: string, key: string) {
  const config = getWorkerConfig();
  if (!config.MINIO_PUBLIC_ENDPOINT) throw new AiozProviderError("AIOZ_IMAGE_ENDPOINT_REQUIRED");
  const minio = createWorkerMinio({ ...config, MINIO_ENDPOINT: config.MINIO_PUBLIC_ENDPOINT });
  // Exceeds the existing 15-minute polling budget; capability is scoped to one object.
  return minio.presignedGetObject(bucket, key, 20 * 60);
}

/**
 * Existing AiTask.summary holds only URL digests and Asset IDs. This survives
 * restarts without persisting a presigned URL or any provider credential.
 * A durable pre-submit reservation refuses ambiguous re-submission: AIOZ has
 * no documented idempotency key or lookup-by-client-id API.
 */
export function createAiozTaskResources(db: PrismaClient, signer: AiozImageSigner = signImage): AiozTaskResources {
  return {
    async prepare(input) {
      const task = await db.aiTask.findUnique({
        where: { id: input.aiTaskId },
        select: { datasetId: true, externalTaskId: true, input: true, summary: true, modelKeySnapshot: true, modality: true, type: true, model: { select: { metadata: true, isActive: true, provider: true } } },
      });
      if (!task || !task.model.isActive || task.model.provider !== "aioz-company" || !((task.modality === "IMAGE" && ["DETECTION", "DETECT_OBJECTS"].includes(task.type)) || (task.modality === "VIDEO" && ["TRACKING", "DETECT_OBJECTS"].includes(task.type)))) throw new AiozProviderError("AIOZ_INVALID_TASK");
      if (task.externalTaskId) return { externalTaskId: task.externalTaskId };
      const summary = z.record(z.string(), z.json()).safeParse(task.summary);
      if (!summary.success) throw new AiozProviderError("AIOZ_INVALID_TASK");
      if (summary.data.aiozSubmission !== undefined) throw new AiozProviderError("AIOZ_SUBMISSION_AMBIGUOUS");
      const persisted = inputSchema.safeParse(task.input);
      if (!persisted.success || input.modelKey !== task.modelKeySnapshot || !z.string().uuid().safeParse(task.modelKeySnapshot).success) throw new AiozProviderError("AIOZ_INVALID_MODEL_OR_INPUT");
      const ids = new Set(persisted.data.assetIds);
      if (ids.size !== persisted.data.assetIds.length || ids.size !== input.assetIds.length || new Set(input.assetIds).size !== ids.size || input.assetIds.some((id) => !ids.has(id))) throw new AiozProviderError("AIOZ_INVALID_INPUT");
      const metadata = z.object({ aioz: optionsSchema.optional() }).safeParse(task.model.metadata);
      if (!metadata.success) throw new AiozProviderError("AIOZ_INVALID_MODEL_OPTIONS");
      const assets = await db.asset.findMany({
        where: { id: { in: [...ids] }, datasetId: task.datasetId, modality: task.modality, deletedAt: null, archivedAt: null },
        select: { id: true, storageProvider: true, storageBucket: true, storageKey: true, cacheProvider: true, cacheBucket: true, cacheKey: true, cacheStatus: true, cacheExpiresAt: true },
      });
      if (assets.length !== ids.size) throw new AiozProviderError("AIOZ_ASSET_UNAVAILABLE");
      const images = [];
      for (const asset of assets) {
        const stored = asset.storageProvider === "MINIO" && asset.storageBucket && asset.storageKey;
        const cached = asset.cacheProvider === "MINIO" && asset.cacheBucket && asset.cacheKey && asset.cacheStatus === "CACHED" && (!asset.cacheExpiresAt || asset.cacheExpiresAt > new Date());
        const bucket = stored ? asset.storageBucket : cached ? asset.cacheBucket : null;
        const key = stored ? asset.storageKey : cached ? asset.cacheKey : null;
        if (!bucket || !key) throw new AiozProviderError("AIOZ_ASSET_BINARY_UNAVAILABLE");
        images.push({ assetId: asset.id, imageUrl: await signer(bucket, key) });
      }
      const manifests = images.map((image) => ({ assetId: image.assetId, urlDigest: digestAiozImageUrl(image.imageUrl) }));
      if (new Set(manifests.map((image) => image.urlDigest)).size !== images.length) throw new AiozProviderError("AIOZ_ASSET_ASSOCIATION_INVALID");
      const reserved = await db.aiTask.updateMany({
        where: { id: input.aiTaskId, externalTaskId: null, summary: { equals: summary.data }, status: { in: ["QUEUED", "RUNNING"] }, job: { status: "RUNNING", cancelRequestedAt: null } },
        data: { summary: { ...summary.data, aiozSubmission: { version: 1, phase: "SUBMITTING", images: manifests } } },
      });
      if (reserved.count !== 1) throw new AiozProviderError("AIOZ_SUBMISSION_NOT_RESERVED");
      const mediaType = task.modality === "VIDEO" ? "video" as const : "image" as const;
      const taskName = task.modality === "VIDEO" ? "tracking" as const : "detection" as const;
      return { modelId: task.modelKeySnapshot, mediaType, taskName, images, options: { ...metadata.data.aioz, confidence_threshold: persisted.data.confidence_threshold ?? metadata.data.aioz?.confidence_threshold ?? 0.5, iou_threshold: persisted.data.iou_threshold ?? metadata.data.aioz?.iou_threshold ?? 0.5, ...(persisted.data.classes ? { classes: persisted.data.classes } : {}) } };
    },
    async recordSubmission(aiTaskId, externalTaskId) {
      // Persist the scanner handoff atomically with the ID, including a crash
      // before processAiSubmit returns and writes its usual scheduling fields.
      const saved = await db.aiTask.updateMany({ where: { id: aiTaskId, externalTaskId: null }, data: { externalTaskId, nextPollAt: new Date(Date.now() + POLL_BASE_DELAY_MS) } });
      if (saved.count !== 1) throw new AiozProviderError("AIOZ_SUBMISSION_PERSIST_FAILED");
    },
    async loadImages(externalTaskId) {
      const task = await db.aiTask.findUnique({ where: { externalTaskId }, select: { summary: true, input: true, modality: true, type: true } });
      const parsed = z.object({ aiozSubmission: manifestSchema }).safeParse(task?.summary);
      const input = inputSchema.safeParse(task?.input);
      if (!parsed.success || !input.success) throw new AiozProviderError("AIOZ_ASSET_ASSOCIATION_INVALID");
      const images = parsed.data.aiozSubmission.images;
      const ids = new Set(input.data.assetIds);
      if (images.length !== ids.size || new Set(images.map((image) => image.assetId)).size !== ids.size || images.some((image) => !ids.has(image.assetId))) throw new AiozProviderError("AIOZ_ASSET_ASSOCIATION_INVALID");
      if (!task || !((task.modality === "IMAGE" && ["DETECTION", "DETECT_OBJECTS"].includes(task.type)) || (task.modality === "VIDEO" && ["TRACKING", "DETECT_OBJECTS"].includes(task.type)))) throw new AiozProviderError("AIOZ_INVALID_TASK");
      return images.map((image) => ({ ...image, mediaType: task.modality === "VIDEO" ? "video" as const : "image" as const }));
    },
  };
}
