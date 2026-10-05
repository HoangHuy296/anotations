import { randomUUID } from "node:crypto";

import { computeAiSourceIdentityDigest, selectAiSourceObject } from "@annotationplatform/domain/ai-batch";
import { createAiPollFixture } from "./ai-fixtures.js";
import { processAiSubmit } from "../../src/jobs/ai-submit.processor.js";
import { AiozAnnotationServicesProvider } from "../../src/providers/ai/aioz-annotation-services-provider.js";
import { createAiozTaskResources } from "../../src/providers/ai/aioz-task-resources.js";

export const config = { baseUrl: "http://aioz.test", apiKey: "fixture-key", timeoutMs: 1000 };
export const worker = "batch-test-worker";
export const lock = "batch-test-lock";
export const SECRET = "SIGNATURE-SECRET-VALUE";

export async function setup(count: number, options: { requesterIsOwner?: boolean } = {}) {
  const f = await createAiPollFixture({ assetCount: count });
  const modelKey = randomUUID();
  await f.db.aiModel.update({ where: { id: f.modelId }, data: { key: modelKey, metadata: { aioz: { confidence_threshold: 0.5, iou_threshold: 0.5 } } } });
  for (const assetId of f.assetIds) await f.db.asset.update({ where: { id: assetId }, data: { sizeBytes: BigInt(10), storageProvider: "MINIO", storageBucket: "ai-test", storageKey: `k/${assetId}` } });
  const assets = await f.db.asset.findMany({ where: { id: { in: f.assetIds } }, orderBy: { id: "asc" } });
  const targets = assets.map((asset, inputIndex) => ({
    assetId: asset.id, inputIndex,
    sourceIdentityDigest: computeAiSourceIdentityDigest({ sourceFingerprint: asset.sourceFingerprint, currentVersionId: asset.currentVersionId, sourceRevision: asset.sourceRevision, sizeBytes: asset.sizeBytes, checksum: asset.checksum, cacheChecksum: asset.cacheChecksum, objectLocator: selectAiSourceObject(asset) }),
  }));
  const jobInput = { schemaVersion: 1, targetMode: "EXPLICIT", datasetId: f.datasetId, modality: "IMAGE", modelId: f.modelId, modelKey, confidence_threshold: 0.5, iou_threshold: 0.5, effectiveLimit: 3, targets };
  let createdById = f.ownerId;
  if (options.requesterIsOwner === false) createdById = (await f.db.user.create({ data: { email: `ai-batch-stranger-${randomUUID()}@test.invalid`, role: "MANAGER" }, select: { id: true } })).id;
  await f.db.job.update({ where: { id: f.jobId }, data: { createdById, lockedBy: worker, lockToken: lock, lockedUntil: new Date(Date.now() + 180_000), input: jobInput, totalItems: count } });
  await f.db.aiTask.update({ where: { id: f.aiTaskId }, data: { modelKeySnapshot: modelKey, externalTaskId: null, input: { confidence_threshold: 0.5, iou_threshold: 0.5, assetIds: targets.map((t) => t.assetId) } } });
  const signer = async (_bucket: string, key: string) => `https://files.test/${key.replace("k/", "")}.jpg?X-Amz-Signature=${SECRET}`;
  const posts: Array<{ files: string[]; model_id: string }> = [];
  const provider = (respond: (init: RequestInit | undefined) => Promise<Response> | Response) =>
    new AiozAnnotationServicesProvider(config, createAiozTaskResources(f.db, signer), async (_url, init) => {
      if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
      return respond(init);
    });
  const created = () => Response.json({ success: true, data: { task_id: randomUUID(), status: "create", created_at: new Date().toISOString() } });
  const everything = async () => JSON.stringify({
    job: await f.db.job.findUniqueOrThrow({ where: { id: f.jobId } }),
    task: await f.db.aiTask.findUniqueOrThrow({ where: { id: f.aiTaskId } }),
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return { ...f, targets, provider, posts, created, everything, modelKey };
}

export const run = (f: Awaited<ReturnType<typeof setup>>, p: AiozAnnotationServicesProvider) => processAiSubmit(f.db, f.jobId, lock, { "aioz-company": p });

