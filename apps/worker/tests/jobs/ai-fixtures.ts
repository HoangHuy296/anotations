import { randomBytes } from "node:crypto";

import { createWorkerDatabase } from "../../src/providers/db.js";
import { getWorkerConfig } from "../../src/config.js";

export const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

/** Dataset + Label + Asset(s) + Job(RUNNING, locked) + AiTask, ready for ai-prediction-writer/ai-poll tests. */
export async function createAiPollFixture(options: { assetCount?: number } = {}) {
  const db = createWorkerDatabase(getWorkerConfig());
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const owner = await db.user.create({ data: { email: `ai-worker-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `ai-worker-${suffix}` }, select: { id: true } });
  const label = await db.label.create({ data: { datasetId: dataset.id, name: "person", normalizedName: "person", color: "#ff0000" }, select: { id: true } });

  const assetCount = options.assetCount ?? 1;
  const assets = await Promise.all(
    Array.from({ length: assetCount }, (_, index) =>
      db.asset.create({
        data: { datasetId: dataset.id, modality: "IMAGE", filename: `fixture-${suffix}-${index}.jpg`, mimeType: "image/jpeg", sourceFingerprint: `ai-worker-${suffix}-${index}` },
        select: { id: true },
      })),
  );

  const model = await db.aiModel.create({
    data: { key: `ai-worker-model-${suffix}`, displayName: "Fixture Model", provider: "aioz-company", modality: "IMAGE", taskType: "DETECT_OBJECTS", isActive: true },
    select: { id: true, key: true },
  });

  const job = await db.job.create({
    data: { datasetId: dataset.id, createdById: owner.id, type: "AI_PREANNOTATE_ASSET", status: "RUNNING" },
    select: { id: true },
  });

  const aiTask = await db.aiTask.create({
    data: {
      datasetId: dataset.id,
      jobId: job.id,
      createdById: owner.id,
      modelId: model.id,
      modelNameSnapshot: "Fixture Model",
      modelKeySnapshot: model.key,
      type: "DETECT_OBJECTS",
      modality: "IMAGE",
      input: { assetIds: assets.map((asset) => asset.id) },
      status: "RUNNING",
      externalTaskId: `external-${suffix}`,
    },
    select: { id: true },
  });

  return {
    db,
    ownerId: owner.id,
    datasetId: dataset.id,
    labelId: label.id,
    assetIds: assets.map((asset) => asset.id),
    modelId: model.id,
    jobId: job.id,
    aiTaskId: aiTask.id,
    cleanup: async () => {
      await db.dataset.delete({ where: { id: dataset.id } }).catch(() => undefined);
      await db.user.delete({ where: { id: owner.id } }).catch(() => undefined);
      await db.$disconnect();
    },
  };
}
