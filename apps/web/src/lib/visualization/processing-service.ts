import "server-only";
import { Prisma } from "@internal/db";
import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { enqueueExistingJob, type EnqueueOptions } from "@/lib/queue/enqueue-job";
import { VISUALIZATION_CAPTURE_ALGORITHM, VISUALIZATION_PROFILE_ALGORITHM, VISUALIZATION_PREVIEW_ALGORITHM } from "@annotationplatform/domain/visualization-processing";

export async function requestVisualizationProcessing(actor: RequestActor, datasetId: string, retryOfJobId?: string, options: EnqueueOptions = {}) {
  const access = await requireDatasetPermission(actor, datasetId, retryOfJobId ? "job.retry" : "dataset.update");
  if (!access || access.forbidden) return { ok: false as const, status: 404 as const };
  let result: { id: string; datasetId: string; type: "VISUALIZATION_CAPTURE" | "VISUALIZATION_DERIVE"; status: "QUEUED" | "RUNNING" | "RETRYING" | "COMPLETED" | "FAILED" | "CANCELING" | "CANCELED" } | undefined;
  let created = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      result = await db.$transaction(async tx => {
        const dataset = await tx.dataset.findFirst({ where: { id: datasetId, deletedAt: null, archivedAt: null, metadata: { path: ["workflowStatus"], equals: "COMPLETED" } }, select: { visualizationGeneration: true, visualizationCurrentSnapshotId: true } });
        if (!dataset) return undefined;
        const select = { id: true, datasetId: true, type: true, status: true } as const;
        const predecessor = retryOfJobId ? await tx.job.findFirst({ where: { id: retryOfJobId, datasetId, status: "FAILED", type: { in: ["VISUALIZATION_CAPTURE", "VISUALIZATION_DERIVE"] } }, select: { id: true, type: true, retrySuccessor: { select } } }) : null;
        if (retryOfJobId && !predecessor) return undefined;
        if (predecessor?.retrySuccessor) return predecessor.retrySuccessor as typeof result;
        const generation = dataset.visualizationGeneration.toString();
        const snapshot = dataset.visualizationCurrentSnapshotId ? await tx.datasetSnapshot.findFirst({ where: { id: dataset.visualizationCurrentSnapshotId, datasetId, generation: dataset.visualizationGeneration } }) : null;
        const type = snapshot ? "VISUALIZATION_DERIVE" as const : "VISUALIZATION_CAPTURE" as const;
        const input = snapshot ? { generation, snapshotId: snapshot.id, profileAlgorithm: VISUALIZATION_PROFILE_ALGORITHM, previewAlgorithm: VISUALIZATION_PREVIEW_ALGORITHM } : { generation, algorithm: VISUALIZATION_CAPTURE_ALGORITHM };
        const key = snapshot ? `visualization:derive:${snapshot.id}:${VISUALIZATION_PROFILE_ALGORITHM}:${VISUALIZATION_PREVIEW_ALGORITHM}` : `visualization:capture:${generation}:${VISUALIZATION_CAPTURE_ALGORITHM}`;
        if (!retryOfJobId) {
          const existing = await tx.job.findFirst({ where: { datasetId, idempotencyKey: key }, select });
          if (existing) return existing as typeof result;
        }
        created = true;
        return await tx.job.create({ data: { datasetId, createdById: actor.id, type, input: input as Prisma.InputJsonValue, ...(retryOfJobId ? { retryOfJobId, trigger: "RETRY" } : { idempotencyKey: key }) }, select }) as typeof result;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      break;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(error.code) && attempt < 3) { created = false; continue; }
      throw error;
    }
  }
  if (!result) return { ok: false as const, status: 409 as const };
  const delivery = result.status === "QUEUED" ? await enqueueExistingJob(result.id, undefined, undefined, options) : null;
  const deliveryPending = delivery?.ok ? delivery.deliveryPending : false;
  return { ok: true as const, status: deliveryPending ? 202 as const : created ? 201 as const : 200 as const, job: result, deliveryPending };
}
