import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify the disposable target before fixtures.
import { randomUUID } from "node:crypto";

import { Modality, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { admitMediaVerification, type AdmissionInput } from "@/lib/media-verification/admission";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";

export const enabled = Boolean(process.env.DATABASE_URL);
export const users: string[] = [];
export const datasets: string[] = [];
export const cleanup = async () => { if (users.length || datasets.length) await cleanupWorkspaceFixture(users, datasets); };

export async function actorWithDataset(modality: Modality = Modality.VIDEO) {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id, modality);
  users.push(owner.id); datasets.push(dataset.id);
  return { actor: { id: owner.id, email: owner.email, name: owner.name, role: owner.role }, datasetId: dataset.id };
}
export async function extraUser() { const user = await createWorkspaceUser(UserRole.MANAGER); users.push(user.id); return user; }

export const BUCKET = "a2-test-bucket";
export const staged = (key = `direct-uploads/${randomUUID()}/clip.mp4`, extra: Partial<{ etag: string; lastModified: Date; sizeBytes: bigint }> = {}) => ({ bucket: BUCKET, key, etag: extra.etag ?? randomUUID().replaceAll("-", ""), sizeBytes: extra.sizeBytes ?? BigInt(4096), lastModified: extra.lastModified ?? new Date(Math.floor(Date.now() / 1000) * 1000), versionId: null });
export const admitInput = (actorId: string, datasetId: string, overrides: Partial<AdmissionInput> = {}): AdmissionInput => ({ actorId, datasetId, source: "DIRECT_UPLOAD", staged: staged(), filename: "clip.mp4", declaredContentType: "video/mp4", declaredSizeBytes: BigInt(4096), ...overrides });
export const admit = (actorId: string, datasetId: string, overrides: Partial<AdmissionInput> = {}) => admitMediaVerification(admitInput(actorId, datasetId, overrides));
export const counts = async (where: { datasetId?: string; requestedById?: string }) => ({
  verifications: await db.mediaVerification.count({ where }),
  jobs: await db.job.count({ where: { type: "VERIFY_UPLOADED_MEDIA", ...(where.datasetId ? { datasetId: where.datasetId } : {}), ...(where.requestedById ? { createdById: where.requestedById } : {}) } }),
});
/** Directly seeds N NON-terminal verifications (fast path for cap-boundary tests; the admission transaction itself is exercised separately). */
export async function seedNonTerminal(input: { datasetId: string; actorId: string; count: number; status?: "PENDING" | "SEALED" | "VERIFIED" }) {
  const rows: Array<{ id: string; jobId: string }> = [];
  for (let index = 0; index < input.count; index += 1) {
    const id = randomUUID();
    const job = await db.job.create({ data: { datasetId: input.datasetId, createdById: input.actorId, type: "VERIFY_UPLOADED_MEDIA", modality: "VIDEO", status: "QUEUED", input: { verificationId: id, contractVersion: 1 } }, select: { id: true } });
    await db.mediaVerification.create({
      data: {
        id, datasetId: input.datasetId, requestedById: input.actorId, source: "DIRECT_UPLOAD", currentJobId: job.id, boundDatasetModality: "VIDEO",
        stagedBucket: BUCKET, stagedKey: `direct-uploads/seed/${id}`, stagedEtag: "e", stagedSizeBytes: BigInt(1), stagedLastModified: new Date(),
        filename: "s.mp4", declaredContentType: "video/mp4", declaredSizeBytes: BigInt(1), verificationDeadlineAt: new Date(Date.now() + 1_800_000),
      },
    });
    rows.push({ id, jobId: job.id });
  }
  return rows;
}
export const terminalize = (id: string) => db.mediaVerification.update({ where: { id }, data: { status: "EXPIRED", resultCode: "UPLOAD_VERIFICATION_EXPIRED", resultReason: "ALLOWANCE_ELAPSED", finishedAt: new Date() } });
