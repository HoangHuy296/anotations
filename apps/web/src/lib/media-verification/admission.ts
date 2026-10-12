import "server-only";

import { randomUUID } from "node:crypto";

import { JobStatus, Prisma } from "@internal/db";
import {
  MEDIA_VERIFICATION_ALLOWANCE_MS, MEDIA_VERIFICATION_CONTRACT_VERSION, MEDIA_VERIFICATION_MAX_NON_TERMINAL, NON_TERMINAL_STATUSES,
  assertMediaVerificationJobCreationAllowed, isTerminalStatus, type MediaVerificationStatus,
} from "@annotationplatform/domain/media-verification";
import { logJobEvent } from "@annotationplatform/domain";

import { db } from "@/lib/db";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";
import { resolveQueueName } from "@/lib/queue/queue-names";

export type StagedIdentity = { bucket: string; key: string; etag: string; sizeBytes: bigint; lastModified: Date; versionId: string | null };

export type AdmissionInput = {
  actorId: string;
  datasetId: string;
  source: "DIRECT_UPLOAD" | "LOCAL_FOLDER_ITEM";
  preparedImportItemId?: string | null;
  staged: StagedIdentity;
  filename: string;
  relativePathHint?: string | null;
  declaredContentType: string;
  declaredSizeBytes: bigint;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Test hook invoked inside the transaction right after the replay lookup (forced serialization conflicts, injected failure between the two creates). */
  hooks?: { afterReplayLookup?: () => Promise<void> | void; betweenCreates?: () => Promise<void> | void };
};

export type VerificationSummary = { id: string; status: MediaVerificationStatus; verificationDeadlineAt: Date; currentJobId: string | null; assetId: string | null };

export type AdmissionResult =
  | { ok: true; replayed: boolean; verification: VerificationSummary; deliveryPending: boolean }
  | { ok: false; status: 429; code: "UPLOAD_VERIFICATION_LIMIT_REACHED"; scope: "ACTOR" | "DATASET"; limit: number }
  | { ok: false; status: 503; code: "UPLOAD_VERIFICATION_BUSY" };

const TRANSACTION_ATTEMPTS = 3;
const SUMMARY = { id: true, status: true, verificationDeadlineAt: true, currentJobId: true, assetId: true, stagedEtag: true, stagedLastModified: true, generation: true } as const;
class LimitReached extends Error { constructor(readonly scope: "ACTOR" | "DATASET") { super("LIMIT"); } }

type Latest = { id: string; status: MediaVerificationStatus; verificationDeadlineAt: Date; currentJobId: string | null; assetId: string | null; stagedEtag: string; stagedLastModified: Date; generation: number };

async function findLatest(tx: Prisma.TransactionClient | typeof db, input: AdmissionInput): Promise<Latest | null> {
  const row = input.preparedImportItemId
    ? await tx.mediaVerification.findFirst({ where: { preparedImportItemId: input.preparedImportItemId }, orderBy: { generation: "desc" }, select: SUMMARY })
    : await tx.mediaVerification.findFirst({ where: { stagedBucket: input.staged.bucket, stagedKey: input.staged.key }, orderBy: { generation: "desc" }, select: SUMMARY });
  return row as Latest | null;
}

/**
 * Whether an existing record answers THIS request (a replay) or a new generation is required. A non-terminal or PUBLISHED record always answers it. A terminal
 * non-PUBLISHED record answers it only while the very same staged object is still there (a client retrying the completion call); a freshly re-uploaded object has
 * a different identity and starts `generation + 1`.
 */
function answersRequest(latest: Latest, input: AdmissionInput): boolean {
  if (!isTerminalStatus(latest.status) || latest.status === "PUBLISHED") return true;
  return latest.stagedEtag === input.staged.etag && Math.floor(latest.stagedLastModified.getTime() / 1000) === Math.floor(input.staged.lastModified.getTime() / 1000);
}

/**
 * Admission (contract sections 5.2 and 8). ONE Serializable transaction: replay lookup -> actor count -> Dataset count -> create MediaVerification + Job (P2034 retried
 * x3, the `retry-job.ts` precedent; exhaustion => 503 UPLOAD_VERIFICATION_BUSY; P2002 => replay). No Redis/MinIO side effect precedes the commit; a refusal creates
 * neither row. After the commit the Job is enqueued (an outage leaves it QUEUED for the recovery scanner: `deliveryPending`). No Asset is ever created here.
 */
export async function admitMediaVerification(input: AdmissionInput): Promise<AdmissionResult> {
  assertMediaVerificationJobCreationAllowed();
  const now = input.now ?? (() => new Date());
  let created: { verification: VerificationSummary; jobId: string; replayed: boolean } | null = null;
  for (let attempt = 0; attempt < TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      created = await db.$transaction(async (tx) => {
        const latest = await findLatest(tx, input);
        await input.hooks?.afterReplayLookup?.();
        if (latest && answersRequest(latest, input)) return { verification: latest, jobId: latest.currentJobId ?? "", replayed: true };
        const [actorCount, datasetCount] = [
          await tx.mediaVerification.count({ where: { requestedById: input.actorId, status: { in: [...NON_TERMINAL_STATUSES] } } }),
          await tx.mediaVerification.count({ where: { datasetId: input.datasetId, status: { in: [...NON_TERMINAL_STATUSES] } } }),
        ];
        if (actorCount >= MEDIA_VERIFICATION_MAX_NON_TERMINAL) throw new LimitReached("ACTOR");
        if (datasetCount >= MEDIA_VERIFICATION_MAX_NON_TERMINAL) throw new LimitReached("DATASET");
        const id = randomUUID();
        const job = await tx.job.create({
          data: { datasetId: input.datasetId, createdById: input.actorId, type: "VERIFY_UPLOADED_MEDIA", modality: "VIDEO", status: JobStatus.QUEUED, totalItems: 1, input: { verificationId: id, contractVersion: MEDIA_VERIFICATION_CONTRACT_VERSION } },
          select: { id: true },
        });
        await input.hooks?.betweenCreates?.();
        const verification = await tx.mediaVerification.create({
          data: {
            id, datasetId: input.datasetId, requestedById: input.actorId, source: input.source, preparedImportItemId: input.preparedImportItemId ?? null, currentJobId: job.id,
            generation: (latest?.generation ?? 0) + 1, boundDatasetModality: "VIDEO",
            stagedBucket: input.staged.bucket, stagedKey: input.staged.key, stagedEtag: input.staged.etag, stagedSizeBytes: input.staged.sizeBytes, stagedLastModified: input.staged.lastModified, stagedVersionId: input.staged.versionId,
            filename: input.filename, relativePathHint: input.relativePathHint ?? null, declaredContentType: input.declaredContentType, declaredSizeBytes: input.declaredSizeBytes,
            verificationDeadlineAt: new Date(now().getTime() + MEDIA_VERIFICATION_ALLOWANCE_MS),
          },
          select: SUMMARY,
        });
        return { verification: verification as Latest, jobId: job.id, replayed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      break;
    } catch (error) {
      if (error instanceof LimitReached) return { ok: false, status: 429, code: "UPLOAD_VERIFICATION_LIMIT_REACHED", scope: error.scope, limit: MEDIA_VERIFICATION_MAX_NON_TERMINAL };
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // A concurrent identical request committed first: it IS the replay.
        const latest = await findLatest(db, input);
        if (latest) { created = { verification: latest, jobId: latest.currentJobId ?? "", replayed: true }; break; }
      }
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt === TRANSACTION_ATTEMPTS - 1) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return { ok: false, status: 503, code: "UPLOAD_VERIFICATION_BUSY" };
        throw error;
      }
    }
  }
  if (!created) return { ok: false, status: 503, code: "UPLOAD_VERIFICATION_BUSY" };
  let deliveryPending = false;
  if (!created.replayed) {
    logJobEvent("JOB_CREATED", { jobId: created.jobId, type: "VERIFY_UPLOADED_MEDIA", status: "QUEUED" });
    const queueName = resolveQueueName("VERIFY_UPLOADED_MEDIA");
    const delivery = queueName ? await enqueueExistingJob(created.jobId, queueName) : { ok: false as const };
    deliveryPending = !delivery.ok || ("deliveryPending" in delivery && Boolean(delivery.deliveryPending));
  }
  const { stagedEtag: _etag, stagedLastModified: _lm, generation: _generation, ...summary } = created.verification as Latest;
  void _etag; void _lm; void _generation;
  return { ok: true, replayed: created.replayed, verification: summary, deliveryPending };
}
