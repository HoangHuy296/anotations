import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify the disposable target before fixtures.
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { Modality, Prisma } from "@internal/db";
import { MediaVerificationNotEnabledError } from "@annotationplatform/domain/media-verification";

import { db } from "@/lib/db";
import { admitMediaVerification } from "@/lib/media-verification/admission";
import { routeToMediaVerification } from "@/lib/media-verification/routing";
import { readVerificationStatus } from "@/lib/media-verification/status";
import { createAndEnqueueFoundationJob } from "@/lib/queue/enqueue-job";
import { retryAuthorizedJob } from "@/lib/jobs/retry-job";
import { commitLocalFolderImport } from "@/lib/imports/commit-local-folder-import";
import { actorWithDataset, admit, admitInput, cleanup, counts, enabled, extraUser, seedNonTerminal, staged, terminalize, users, datasets } from "./support";

after(cleanup);
const skip = !enabled;
const noQueue = { createQueue: () => ({ queue: { add: async () => ({}) }, close: async () => undefined }) };

test("release guard: with MEDIA_VERIFICATION_ENABLED unset, admission refuses before creating anything", { skip }, async () => {
  delete process.env.MEDIA_VERIFICATION_ENABLED;
  const { actor, datasetId } = await actorWithDataset();
  await assert.rejects(() => admit(actor.id, datasetId), MediaVerificationNotEnabledError);
  assert.deepEqual(await counts({ datasetId }), { verifications: 0, jobs: 0 });
  assert.deepEqual(await routeToMediaVerification({ minio: { statObject: async () => { throw new Error("must not be called"); } }, bucket: "b", capability: { actorId: actor.id, datasetId, objectKey: "k", filename: "a.mp4", candidateContentType: "video/mp4", sizeBytes: 1 }, source: "DIRECT_UPLOAD" }), { kind: "not_eligible" });
  process.env.MEDIA_VERIFICATION_ENABLED = "1";
});

test("admission creates exactly one PENDING verification + one QUEUED Job with the strict input, no Asset, a 30-minute allowance and a delivered queue entry", { skip }, async () => {
  process.env.MEDIA_VERIFICATION_ENABLED = "1";
  const { actor, datasetId } = await actorWithDataset();
  const before = Date.now();
  const result = await admit(actor.id, datasetId);
  assert.ok(result.ok && !result.replayed);
  const row = await db.mediaVerification.findUniqueOrThrow({ where: { id: result.verification.id }, include: { currentJob: true } });
  assert.equal(row.status, "PENDING"); assert.equal(row.generation, 1); assert.equal(row.boundDatasetModality, "VIDEO"); assert.equal(row.sealedKey, null); assert.equal(row.assetId, null);
  assert.deepEqual(row.currentJob!.input, { verificationId: row.id, contractVersion: 1 }); assert.equal(row.currentJob!.type, "VERIFY_UPLOADED_MEDIA"); assert.equal(row.currentJob!.createdById, actor.id);
  const allowance = row.verificationDeadlineAt.getTime() - before;
  assert.ok(allowance > 29 * 60_000 && allowance <= 30 * 60_000 + 5_000, `allowance ${allowance}`);
  assert.equal(await db.asset.count({ where: { datasetId } }), 0, "admission never creates an Asset");
  assert.ok(row.currentJob!.enqueuedAt, "post-commit enqueue happened (real Redis)");
});

test("replay: the same staged object returns the SAME record and creates no row, Job or slot; a terminal non-PUBLISHED record answers only the same staged identity, a re-upload is generation + 1", { skip }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  const object = staged();
  const first = await admit(actor.id, datasetId, { staged: object });
  assert.ok(first.ok);
  const again = await admit(actor.id, datasetId, { staged: object });
  assert.ok(again.ok && again.replayed && again.verification.id === first.verification.id);
  assert.deepEqual(await counts({ datasetId }), { verifications: 1, jobs: 1 });
  await terminalize(first.verification.id);
  const sameIdentity = await admit(actor.id, datasetId, { staged: object });
  assert.ok(sameIdentity.ok && sameIdentity.replayed && sameIdentity.verification.id === first.verification.id, "a retry of the completion call after a terminal outcome answers from the record");
  const reupload = await admit(actor.id, datasetId, { staged: staged(object.key) });
  assert.ok(reupload.ok && !reupload.replayed && reupload.verification.id !== first.verification.id);
  assert.equal((await db.mediaVerification.findUniqueOrThrow({ where: { id: reupload.verification.id } })).generation, 2);
});

test("folder item replay/generation: keyed by (preparedImportItemId, generation)", { skip }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  const receipt = await db.job.create({ data: { datasetId, createdById: actor.id, type: "IMPORT_DATASET", status: "RUNNING", totalItems: 1, input: {} }, select: { id: true } });
  const prepared = await db.preparedImport.create({ data: { datasetId, jobId: receipt.id, createdById: actor.id, expectedItemCount: 1, deadlineAt: new Date(Date.now() + 1_800_000), idempotencyKey: `k-${Date.now()}` }, select: { id: true } });
  const item = await db.preparedImportItem.create({ data: { preparedImportId: prepared.id, logicalPath: "d/a.mp4", normalizedPath: "d/a.mp4", filename: "a.mp4", mimeType: "video/mp4", sizeBytes: BigInt(4096), modality: "VIDEO", position: 0, fingerprint: "f".repeat(64), storageKey: `prepared-imports/${datasetId}/item-a/a.mp4` }, select: { id: true } });
  const object = staged(`prepared-imports/${datasetId}/item-a/a.mp4`);
  const one = await admit(actor.id, datasetId, { source: "LOCAL_FOLDER_ITEM", preparedImportItemId: item.id, staged: object, relativePathHint: "d/a.mp4" });
  const two = await admit(actor.id, datasetId, { source: "LOCAL_FOLDER_ITEM", preparedImportItemId: item.id, staged: object, relativePathHint: "d/a.mp4" });
  assert.ok(one.ok && two.ok && two.replayed && one.verification.id === two.verification.id);
  assert.equal(await db.mediaVerification.count({ where: { preparedImportItemId: item.id } }), 1);
});

test("cap (frozen semantics): the 51st non-terminal request is refused 429 with its scope; the refusal creates no Job and no verification; replay at the cap still returns the record; a terminal release admits the next", { skip }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  const seeded = await seedNonTerminal({ datasetId, actorId: actor.id, count: 49 });
  const fifty = await admit(actor.id, datasetId);
  assert.ok(fifty.ok, "the 50th is admitted");
  const before = await counts({ datasetId });
  const refused = await admit(actor.id, datasetId);
  assert.deepEqual(refused.ok ? null : { status: refused.status, code: refused.code, scope: (refused as { scope?: string }).scope, limit: (refused as { limit?: number }).limit }, { status: 429, code: "UPLOAD_VERIFICATION_LIMIT_REACHED", scope: "ACTOR", limit: 50 });
  assert.deepEqual(await counts({ datasetId }), before, "a refusal creates neither a Job nor a verification");
  const replay = await admit(actor.id, datasetId, { staged: { ...staged(), key: (await db.mediaVerification.findUniqueOrThrow({ where: { id: fifty.verification.id } })).stagedKey, etag: (await db.mediaVerification.findUniqueOrThrow({ where: { id: fifty.verification.id } })).stagedEtag } });
  assert.ok(replay.ok && replay.replayed, "replay consumes no slot even at the cap");
  await terminalize(seeded[0]!.id);
  const next = await admit(actor.id, datasetId);
  assert.ok(next.ok && !next.replayed, "terminalization released a slot");
  assert.equal(await db.mediaVerification.count({ where: { requestedById: actor.id, status: { in: ["PENDING", "SEALED", "VERIFIED"] } } }), 50);
});

test("cap scopes are independent: 50 from OTHER actors saturate the Dataset (a new actor is refused with scope DATASET) while the saturated actors' other Datasets stay open", { skip }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  const other = await extraUser();
  await seedNonTerminal({ datasetId, actorId: other.id, count: 50 });
  const refused = await admit(actor.id, datasetId);
  assert.ok(!refused.ok && refused.status === 429 && (refused as { scope: string }).scope === "DATASET");
  const second = await actorWithDataset();
  const otherElsewhere = await admit(other.id, second.datasetId);
  assert.equal(otherElsewhere.ok, false, "the actor scope (50 across all Datasets) still binds `other`");
  assert.equal((otherElsewhere as { scope?: string }).scope, "ACTOR");
  const fresh = await admit(second.actor.id, second.datasetId);
  assert.ok(fresh.ok, "an unrelated actor in an unrelated Dataset is unaffected");
});

test("retry exhaustion maps to 503 UPLOAD_VERIFICATION_BUSY (forced P2034 x3) and leaves no partial rows", { skip }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  const original = db.$transaction.bind(db);
  let calls = 0;
  (db as unknown as { $transaction: unknown }).$transaction = async () => { calls += 1; throw new Prisma.PrismaClientKnownRequestError("write conflict", { code: "P2034", clientVersion: "test" }); };
  try {
    const result = await admit(actor.id, datasetId);
    assert.deepEqual(result.ok ? null : { status: result.status, code: result.code }, { status: 503, code: "UPLOAD_VERIFICATION_BUSY" });
    assert.equal(calls, 3, "exactly three attempts");
  } finally { (db as unknown as { $transaction: unknown }).$transaction = original; }
  assert.deepEqual(await counts({ datasetId }), { verifications: 0, jobs: 0 });
});

test("atomicity: a failure between the two creates rolls BOTH back (no orphan PENDING verification without its Job, no Job without its verification)", { skip }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  await assert.rejects(() => admitMediaVerification(admitInput(actor.id, datasetId, { hooks: { betweenCreates: () => { throw new Error("injected"); } } })), /injected/);
  assert.deepEqual(await counts({ datasetId }), { verifications: 0, jobs: 0 });
});

test("a verification Job can never be created from a browser-supplied Job request", { skip }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  const result = await createAndEnqueueFoundationJob(actor, { datasetId, type: "VERIFY_UPLOADED_MEDIA", input: { verificationId: "x" } });
  assert.deepEqual({ ok: result.ok, status: (result as { status?: number }).status }, { ok: false, status: 400 });
  assert.equal((await counts({ datasetId })).jobs, 0);
});

test("routing eligibility: only an enabled system + VIDEO Dataset + video/mp4|webm is routed; a missing object or a size mismatch is UPLOAD_NOT_READY; nothing else is ever routed", { skip }, async () => {
  process.env.MEDIA_VERIFICATION_ENABLED = "1";
  const video = await actorWithDataset(Modality.VIDEO); const image = await actorWithDataset(Modality.IMAGE); const audio = await actorWithDataset(Modality.AUDIO);
  const stat = (size: number) => ({ statObject: async () => ({ size, etag: "\"abc\"", lastModified: new Date(), versionId: null }) as never });
  const base = (a: typeof video, over: Record<string, unknown> = {}) => ({ minio: stat(4096), bucket: "b", source: "DIRECT_UPLOAD" as const, capability: { actorId: a.actor.id, datasetId: a.datasetId, objectKey: `direct-uploads/${Math.random()}/a.mp4`, filename: "a.mp4", candidateContentType: "video/mp4", sizeBytes: 4096, ...over } });
  assert.equal((await routeToMediaVerification(base(video))).kind, "admitted");
  assert.equal((await routeToMediaVerification(base(video, { candidateContentType: "video/webm", objectKey: `direct-uploads/${Math.random()}/b.webm` }))).kind, "admitted");
  for (const type of ["audio/mpeg", "audio/wav", "image/png", "text/plain", "application/json", "video/quicktime"]) assert.equal((await routeToMediaVerification(base(video, { candidateContentType: type }))).kind, "not_eligible", type);
  assert.equal((await routeToMediaVerification(base(image))).kind, "not_eligible"); assert.equal((await routeToMediaVerification(base(audio))).kind, "not_eligible");
  assert.equal((await routeToMediaVerification({ ...base(video), minio: stat(1) })).kind, "not_ready");
  assert.equal((await routeToMediaVerification({ ...base(video), minio: { statObject: async () => { throw new Error("NoSuchKey"); } } as never })).kind, "not_ready");
  assert.equal((await counts({ datasetId: image.datasetId })).verifications + (await counts({ datasetId: audio.datasetId })).verifications, 0);
});

test("status endpoint DTO: requester and dataset readers see it; a foreign actor and an unknown id get null (404); it never exposes keys, buckets, ETags or hashes; derived VERIFICATION_FAILED stays retryable", { skip }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  const stranger = await extraUser();
  const result = await admit(actor.id, datasetId);
  assert.ok(result.ok);
  const mine = await readVerificationStatus(actor, result.verification.id);
  assert.equal(mine?.status, "PENDING"); assert.ok(mine?.pollAfterMs && mine.pollAfterMs > 0);
  assert.equal(await readVerificationStatus({ id: stranger.id, email: stranger.email, name: stranger.name, role: stranger.role }, result.verification.id), null);
  assert.equal(await readVerificationStatus(actor, "00000000-0000-4000-8000-000000000000"), null);
  const row = await db.mediaVerification.findUniqueOrThrow({ where: { id: result.verification.id } });
  const text = JSON.stringify(mine);
  for (const secret of [row.stagedKey, row.stagedBucket, row.stagedEtag, "sha256"]) assert.equal(text.includes(secret), false, `DTO leaks ${secret}`);
  // operational failure view
  await db.mediaVerification.update({ where: { id: row.id }, data: { status: "SEALED", sealedKey: `verified-uploads/${datasetId}/${row.id}/source`, sealedEtag: "e", sealedSizeBytes: BigInt(1), sealedLastModified: new Date(), sealedAt: new Date(), lastFailureCode: "VERIFICATION_EXECUTION_EXHAUSTED", lastFailureReason: "UPLOAD_VERIFICATION_PROBE_TIMEOUT", lastFailureAt: new Date() } });
  await db.job.update({ where: { id: row.currentJobId! }, data: { status: "FAILED", errorCode: "VERIFICATION_EXECUTION_EXHAUSTED", finishedAt: new Date() } });
  const failed = await readVerificationStatus(actor, row.id);
  assert.deepEqual({ status: failed?.status, code: failed?.code, reason: failed?.reason, retryable: failed?.retryable }, { status: "VERIFICATION_FAILED", code: "VERIFICATION_EXECUTION_EXHAUSTED", reason: "UPLOAD_VERIFICATION_PROBE_TIMEOUT", retryable: true });
  await db.mediaVerification.update({ where: { id: row.id }, data: { status: "REJECTED", resultCode: "UNSUPPORTED_MEDIA", resultReason: "CODEC_UNSUPPORTED", finishedAt: new Date(), probe: {}, contentSha256: "c".repeat(64) } });
  const rejected = await readVerificationStatus(actor, row.id);
  assert.deepEqual({ status: rejected?.status, code: rejected?.code, reason: rejected?.reason, retryable: rejected?.retryable, asset: rejected?.asset }, { status: "REJECTED", code: "UNSUPPORTED_MEDIA", reason: "CODEC_UNSUPPORTED", retryable: undefined, asset: undefined });
});

test("retry matrix: only an OPERATIONAL failure on a non-terminal verification inside its allowance may produce a successor (which takes over currentJobId); rejection, stale, expiry and an elapsed allowance are 409", { skip }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  const make = async (errorCode: string, patch: Record<string, unknown> = {}) => {
    const r = await admit(actor.id, datasetId); assert.ok(r.ok);
    const row = await db.mediaVerification.findUniqueOrThrow({ where: { id: r.verification.id } });
    await db.job.update({ where: { id: row.currentJobId! }, data: { status: "FAILED", errorCode, finishedAt: new Date() } });
    if (Object.keys(patch).length) await db.mediaVerification.update({ where: { id: row.id }, data: patch });
    return row;
  };
  const operational = await make("VERIFICATION_EXECUTION_EXHAUSTED");
  const original = { id: operational.currentJobId! };
  const ok = await retryAuthorizedJob(actor, original.id, noQueue);
  assert.ok(ok.ok && ok.status === 201, JSON.stringify(ok));
  const moved = await db.mediaVerification.findUniqueOrThrow({ where: { id: operational.id }, select: { currentJobId: true } });
  assert.equal(moved.currentJobId, ok.ok ? ok.job.id : null, "the verification follows its retry successor");
  const successor = await db.job.findUniqueOrThrow({ where: { id: moved.currentJobId! }, select: { input: true, retryOfJobId: true, type: true } });
  assert.deepEqual(successor.input, { verificationId: operational.id, contractVersion: 1 }); assert.equal(successor.retryOfJobId, operational.currentJobId);
  const again = await retryAuthorizedJob(actor, original.id, noQueue);
  assert.ok(again.ok && again.status === 200 && again.job.id === (ok.ok ? ok.job.id : ""), "a second retry of the same predecessor reuses the one successor");
  const rejected = await make("UNSUPPORTED_MEDIA", { status: "REJECTED", resultCode: "UNSUPPORTED_MEDIA", resultReason: "CONTAINER_UNSUPPORTED", finishedAt: new Date(), probe: {}, contentSha256: "d".repeat(64) });
  const stale = await make("UPLOAD_SOURCE_CHANGED", { status: "STALE", resultCode: "UPLOAD_SOURCE_CHANGED", resultReason: "SOURCE_STAGED_CHANGED", finishedAt: new Date() });
  const expired = await make("UPLOAD_VERIFICATION_EXPIRED", { status: "EXPIRED", resultCode: "UPLOAD_VERIFICATION_EXPIRED", resultReason: "ALLOWANCE_ELAPSED", finishedAt: new Date() });
  const lapsed = await make("VERIFICATION_EXECUTION_EXHAUSTED", { verificationDeadlineAt: new Date(Date.now() - 1000) });
  for (const [label, row] of [["rejected", rejected], ["stale", stale], ["expired", expired], ["allowance elapsed", lapsed]] as const) {
    const result = await retryAuthorizedJob(actor, row.currentJobId!, noQueue);
    assert.deepEqual({ label, ok: result.ok, status: result.status }, { label, ok: false, status: 409 });
  }
});

test("folder commit (D9): a pending verification answers 409 UPLOAD_VERIFICATION_PENDING with a `verifying` count and does NOT fail the import Job; after it settles the commit succeeds", { skip }, async () => {
  const { actor, datasetId } = await actorWithDataset();
  const receipt = await db.job.create({ data: { datasetId, createdById: actor.id, type: "IMPORT_DATASET", status: "RUNNING", totalItems: 1, input: {} }, select: { id: true } });
  const prepared = await db.preparedImport.create({ data: { datasetId, jobId: receipt.id, createdById: actor.id, expectedItemCount: 1, deadlineAt: new Date(Date.now() + 1_800_000), idempotencyKey: `k-${Date.now()}` }, select: { id: true } });
  const item = await db.preparedImportItem.create({ data: { preparedImportId: prepared.id, logicalPath: "d/a.mp4", normalizedPath: "d/a.mp4", filename: "a.mp4", mimeType: "video/mp4", sizeBytes: BigInt(4096), modality: "VIDEO", position: 0, fingerprint: "f".repeat(64), storageKey: `prepared-imports/${datasetId}/item-c/a.mp4` }, select: { id: true } });
  const admitted = await admit(actor.id, datasetId, { source: "LOCAL_FOLDER_ITEM", preparedImportItemId: item.id, staged: staged(`prepared-imports/${datasetId}/item-c/a.mp4`), relativePathHint: "d/a.mp4" });
  assert.ok(admitted.ok);
  const pending = await commitLocalFolderImport(actor, receipt.id);
  assert.deepEqual(pending.ok ? null : { status: pending.status, code: (pending as { code?: string }).code, verifying: (pending as { verifying?: number }).verifying, unprocessed: (pending as { unprocessed?: number }).unprocessed }, { status: 409, code: "UPLOAD_VERIFICATION_PENDING", verifying: 1, unprocessed: 0 });
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: receipt.id }, select: { status: true } })).status, "RUNNING", "the import Job is not failed");
  // publication (what the worker does in one transaction): the item gets its Asset and the verification is PUBLISHED
  const asset = await db.asset.create({ data: { datasetId, modality: "VIDEO", filename: "a.mp4", mimeType: "video/mp4", sourceFingerprint: `fp-${Date.now()}`, status: "READY", videoAsset: { create: { metadata: {} } } }, select: { id: true } });
  await db.preparedImportItem.update({ where: { id: item.id }, data: { assetId: asset.id, completedAt: new Date() } });
  await db.jobEvent.create({ data: { id: `phase029_import_success_${item.id}`, jobId: receipt.id, message: "IMPORT_ITEM_SUCCEEDED", data: { itemId: item.id, disposition: "accepted" } } });
  await db.mediaVerification.update({ where: { id: admitted.verification.id }, data: { status: "PUBLISHED", assetId: asset.id, sealedKey: `verified-uploads/${datasetId}/${admitted.verification.id}/source`, sealedEtag: "e", sealedSizeBytes: BigInt(1), sealedLastModified: new Date(), sealedAt: new Date(), contentSha256: "e".repeat(64), probe: {}, verifiedModality: "VIDEO", policyVersion: "premedia-verify.v2", processorVersion: "x", verifiedAt: new Date(), publishedAt: new Date(), finishedAt: new Date() } });
  const committed = await commitLocalFolderImport(actor, receipt.id);
  assert.ok(committed.ok && committed.status === 200 && (committed as { accepted: number }).accepted === 1, JSON.stringify(committed));
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: receipt.id }, select: { status: true } })).status, "COMPLETED");
});
void users; void datasets;
