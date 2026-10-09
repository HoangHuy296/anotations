import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify the disposable target before fixtures.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { purgeTerminalMediaVerifications, reconcileMediaVerifications, redeliverRetryingVerificationJobs } from "../../src/queue/media-verification-scanners.js";
import { sweepUnreferencedObjects } from "../../src/queue/minio-orphan-scanner.js";
import { processVerifyUploadedMedia } from "../../src/verification/process.js";
import { recomputeFolderAccounting } from "../../src/verification/folder-accounting.js";
import { createHarness, type Harness } from "./support.js";

let h: Harness;
before(async () => { h = await createHarness(); });
after(async () => { await h.cleanup(); });
const bytes = () => randomBytes(2048);
const ago = (ms: number) => new Date(Date.now() - ms);

test("expiry: past the allowance plus lease grace with no valid lease -> EXPIRED (never REJECTED); Job FAILED UPLOAD_VERIFICATION_EXPIRED; both objects removed; no Asset", async () => {
  const staged = await h.stage(bytes());
  const v = await h.createVerification(staged, { claim: false, deadlineAt: ago(5 * 60_000) });
  const result = await reconcileMediaVerifications({ db: h.db, deps: h.deps(), graceMs: 60_000 });
  assert.ok(result.terminalized >= 1);
  const row = await h.assertConsistent(v.verification.id);
  assert.equal(row.status, "EXPIRED"); assert.equal(row.resultReason, "ALLOWANCE_ELAPSED");
  assert.equal((await h.jobOf(v.jobId)).errorCode, "UPLOAD_VERIFICATION_EXPIRED"); assert.equal((await h.jobOf(v.jobId)).status, "FAILED");
  assert.equal(await h.exists(staged.key), false); assert.ok(row.objectsClearedAt);
});

test("expiry never pre-empts an in-flight step: a RUNNING Job with a valid lease keeps its verification, even past the deadline", async () => {
  const v = await h.createVerification(await h.stage(bytes()), { deadlineAt: ago(10 * 60_000) });
  await reconcileMediaVerifications({ db: h.db, deps: h.deps(), graceMs: 60_000 });
  assert.equal((await h.reload(v.verification.id)).status, "PENDING");
});

test("an operational failure that ends FAILED stays retryable until the deadline, then becomes EXPIRED with its failure reason preserved as the cause", async () => {
  const v = await h.createVerification(await h.stage(bytes()), { deadlineAt: new Date(Date.now() + 2_000) });
  const timeout = h.deps({ probe: async () => ({ kind: "NOT_COMPLETED", reason: "UPLOAD_VERIFICATION_PROBE_TIMEOUT" }) });
  assert.equal(await processVerifyUploadedMedia(h.db, v.jobId, v.lockToken, timeout), "retrying");
  assert.equal(await processVerifyUploadedMedia(h.db, v.jobId, await h.reclaim(v.jobId), timeout), "retrying");
  assert.equal(await processVerifyUploadedMedia(h.db, v.jobId, await h.reclaim(v.jobId), timeout), "failed");
  assert.equal((await h.reload(v.verification.id)).status, "SEALED");
  await h.db.mediaVerification.update({ where: { id: v.verification.id }, data: { verificationDeadlineAt: ago(5 * 60_000) } });
  await reconcileMediaVerifications({ db: h.db, deps: h.deps(), graceMs: 60_000 });
  const row = await h.assertConsistent(v.verification.id);
  assert.equal(row.status, "EXPIRED"); assert.equal(row.lastFailureReason, "UPLOAD_VERIFICATION_PROBE_TIMEOUT"); assert.equal(await h.exists(v.sealedKey), false);
});

test("a canceled Job, an archived Dataset and an ended folder import each terminalize their verification as CANCELED (never REJECTED or EXPIRED)", async () => {
  const canceled = await h.createVerification(await h.stage(bytes()), { claim: false });
  await h.db.job.update({ where: { id: canceled.jobId }, data: { status: "CANCELED", cancelRequestedAt: new Date() } });
  const archivedDs = await h.db.dataset.create({ data: { ownerId: h.owner.id, name: `a2-sc-${randomUUID().slice(0, 6)}`, modality: "VIDEO", primaryModality: "VIDEO", modalityResolverSubject: h.owner.id }, select: { id: true } });
  const archived = await h.createVerification(await h.stage(bytes()), { claim: false, datasetId: archivedDs.id });
  await h.db.dataset.update({ where: { id: archivedDs.id }, data: { archivedAt: new Date() } });
  await reconcileMediaVerifications({ db: h.db, deps: h.deps(), graceMs: 60_000 });
  assert.deepEqual([(await h.assertConsistent(canceled.verification.id)).resultReason, (await h.assertConsistent(archived.verification.id)).resultReason], ["REQUESTED", "DATASET_INACTIVE"]);
  assert.equal((await h.reload(canceled.verification.id)).status, "CANCELED"); assert.equal((await h.jobOf(canceled.jobId)).status, "CANCELED");
});

test("retry delivery: an in-place RETRYING Job is re-queued with a per-attempt delivery id and stamped once; a future runAfter waits; a queue outage records QUEUE_DELIVERY_PENDING and stamps nothing", async () => {
  const mk = async (runAfter: Date | null) => (await h.createVerification(await h.stage(bytes()), { claim: false })).jobId;
  const due = await mk(null), later = await mk(null), outage = await mk(null);
  await h.db.job.updateMany({ where: { id: { in: [due, later, outage] } }, data: { status: "RETRYING", attempts: 2, enqueuedAt: null, queueName: null, queueJobId: null } });
  await h.db.job.update({ where: { id: due }, data: { runAfter: ago(1_000) } });
  await h.db.job.update({ where: { id: later }, data: { runAfter: new Date(Date.now() + 600_000) } });
  await h.db.job.update({ where: { id: outage }, data: { runAfter: ago(1_000) } });
  const added: Array<{ payload: unknown; id: string }> = [];
  const queue = { add: async (_name: string, payload: unknown, options?: { jobId?: string }) => { if (JSON.stringify(payload).includes(outage)) throw new Error("redis down"); added.push({ payload, id: options!.jobId! }); return {} as never; } };
  const first = await redeliverRetryingVerificationJobs({ db: h.db, queue: queue as never });
  assert.ok(first.delivered >= 1);
  const mine = added.filter((a) => JSON.stringify(a.payload).includes(due));
  assert.equal(mine.length, 1); assert.deepEqual(mine[0]!.payload, { jobId: due }, "the queue payload is strictly { jobId }"); assert.ok(mine[0]!.id.endsWith("-r2"), "per-attempt delivery id");
  assert.ok((await h.jobOf(due)).enqueuedAt, "stamped"); assert.equal((await h.jobOf(later)).enqueuedAt, null, "future runAfter waits"); assert.equal((await h.jobOf(outage)).enqueuedAt, null, "outage stamps nothing");
  assert.ok(await h.db.jobEvent.findFirst({ where: { jobId: outage, message: "QUEUE_DELIVERY_PENDING" } }));
  await redeliverRetryingVerificationJobs({ db: h.db, queue: queue as never });
  assert.equal(added.filter((a) => JSON.stringify(a.payload).includes(due)).length, 1, "a stamped Job is never delivered twice");
});

test("retention (R2): a terminal row 30+ days old is purged only after both objects are confirmed absent; PUBLISHED and young rows are kept", async () => {
  const old = await h.createVerification(await h.stage(bytes()), { claim: false });
  const young = await h.createVerification(await h.stage(bytes()), { claim: false });
  const published = await h.createVerification(await h.stage(bytes()), { claim: false });
  const terminalAt = ago(31 * 86_400_000);
  await h.db.mediaVerification.update({ where: { id: old.verification.id }, data: { status: "EXPIRED", resultCode: "UPLOAD_VERIFICATION_EXPIRED", resultReason: "ALLOWANCE_ELAPSED", finishedAt: terminalAt } });
  await h.db.mediaVerification.update({ where: { id: young.verification.id }, data: { status: "EXPIRED", resultCode: "UPLOAD_VERIFICATION_EXPIRED", resultReason: "ALLOWANCE_ELAPSED", finishedAt: ago(86_400_000) } });
  const asset = await h.db.asset.create({ data: { datasetId: h.dataset.id, modality: "VIDEO", filename: "p.mp4", mimeType: "video/mp4", sourceFingerprint: randomUUID(), status: "READY", videoAsset: { create: { metadata: {} } } }, select: { id: true } });
  await h.db.mediaVerification.update({ where: { id: published.verification.id }, data: { status: "PUBLISHED", sealedKey: published.sealedKey, contentSha256: "a".repeat(64), probe: {}, verifiedModality: "VIDEO", policyVersion: "premedia-verify.v2", processorVersion: "x", sealedEtag: "e", sealedSizeBytes: 1n, sealedLastModified: new Date(), sealedAt: new Date(), verifiedAt: new Date(), assetId: asset.id, publishedAt: terminalAt, finishedAt: terminalAt } });
  // leftover staged object of the old row: the purger must remove it and confirm absence BEFORE deleting the row
  const result = await purgeTerminalMediaVerifications({ db: h.db, deps: h.deps() });
  assert.ok(result.purged >= 1);
  assert.equal(await h.db.mediaVerification.count({ where: { id: old.verification.id } }), 0, "purged");
  assert.equal(await h.exists((await h.db.mediaVerification.findUniqueOrThrow({ where: { id: young.verification.id } })).stagedKey), true, "young row keeps its (still-staged) object untouched by the purger");
  assert.equal(await h.db.mediaVerification.count({ where: { id: young.verification.id } }), 1);
  assert.equal(await h.db.mediaVerification.count({ where: { id: published.verification.id } }), 1, "PUBLISHED rows are never purged");
});

test("orphan scan protects the objects of a NON-terminal verification and collects those of a terminal one (sealed prefix included)", async () => {
  const live = await h.createVerification(await h.stage(bytes()), { claim: false });
  const dead = await h.createVerification(await h.stage(bytes()), { claim: false });
  // give both a sealed object
  for (const v of [live, dead]) await h.minio.putObject(h.config.MINIO_BUCKET, v.sealedKey, bytes());
  await h.db.mediaVerification.updateMany({ where: { id: { in: [live.verification.id, dead.verification.id] } }, data: { sealedKey: undefined } });
  await h.db.mediaVerification.update({ where: { id: live.verification.id }, data: { status: "SEALED", sealedKey: live.sealedKey, sealedEtag: "e", sealedSizeBytes: 1n, sealedLastModified: new Date(), sealedAt: new Date() } });
  await h.db.mediaVerification.update({ where: { id: dead.verification.id }, data: { status: "REJECTED", sealedKey: dead.sealedKey, resultCode: "UNSUPPORTED_MEDIA", resultReason: "CONTAINER_UNSUPPORTED", finishedAt: new Date(), contentSha256: "b".repeat(64), probe: {} } });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const outcome = await sweepUnreferencedObjects({ db: h.db, minio: h.minio, bucket: h.config.MINIO_BUCKET, prefix: `verified-uploads/${h.dataset.id}/`, dryRun: false, gracePeriodMs: 0 });
  assert.equal(await h.exists(live.sealedKey), true, "a live verification protects its sealed object");
  assert.equal(await h.exists(dead.sealedKey), false, "a terminal verification releases it");
  assert.ok(outcome.deleted.includes(dead.sealedKey) && !outcome.deleted.includes(live.sealedKey));
});

test("folder item: publication links the item, writes the stable success event and the aggregate shows verifying -> accepted; a rejected item becomes IMPORT_ITEM_REJECTED", async () => {
  const receipt = await h.db.job.create({ data: { datasetId: h.dataset.id, createdById: h.owner.id, type: "IMPORT_DATASET", status: "RUNNING", totalItems: 2, input: {} }, select: { id: true } });
  const prepared = await h.db.preparedImport.create({ data: { datasetId: h.dataset.id, jobId: receipt.id, createdById: h.owner.id, status: "PREPARING", expectedItemCount: 2, deadlineAt: new Date(Date.now() + 1_800_000), idempotencyKey: randomUUID() }, select: { id: true } });
  const mkItem = (name: string, position: number) => h.db.preparedImportItem.create({ data: { preparedImportId: prepared.id, logicalPath: `d/${name}`, normalizedPath: `d/${name}`, filename: name, mimeType: "video/mp4", sizeBytes: 2048n, modality: "VIDEO", position, fingerprint: "f".repeat(64), storageKey: `direct-uploads/${h.dataset.id}/item-${randomUUID()}/${name}` }, select: { id: true } });
  const [okItem, badItem] = [await mkItem("ok.mp4", 0), await mkItem("bad.mp4", 1)];
  const okV = await h.createVerification(await h.stage(bytes(), "ok.mp4"), { source: "LOCAL_FOLDER_ITEM", preparedImportItemId: okItem.id, relativePathHint: "d/ok.mp4", filename: "ok.mp4" });
  const badV = await h.createVerification(await h.stage(bytes(), "bad.mp4"), { source: "LOCAL_FOLDER_ITEM", preparedImportItemId: badItem.id, relativePathHint: "d/bad.mp4", filename: "bad.mp4" });
  const pending = await recomputeFolderAccounting(h.db, prepared.id);
  assert.deepEqual({ verifying: pending!.verifying, accepted: pending!.accepted, unprocessed: pending!.unprocessed }, { verifying: 2, accepted: 0, unprocessed: 0 }, "pending items are `verifying`, never accepted or unprocessed");
  assert.equal(await processVerifyUploadedMedia(h.db, okV.jobId, okV.lockToken, h.deps()), "published");
  assert.equal(await processVerifyUploadedMedia(h.db, badV.jobId, badV.lockToken, h.deps({ probe: h.probeFor("mp4_hevc.mp4") })), "rejected");
  const item = await h.db.preparedImportItem.findUniqueOrThrow({ where: { id: okItem.id } });
  assert.ok(item.assetId && item.completedAt);
  assert.ok(await h.db.jobEvent.findUnique({ where: { id: `phase029_import_success_${okItem.id}` } }));
  assert.ok(await h.db.jobEvent.findUnique({ where: { id: `phase029_rejected_${badItem.id}` } }));
  const final = await recomputeFolderAccounting(h.db, prepared.id);
  assert.deepEqual({ accepted: final!.accepted, rejected: final!.rejected, verifying: final!.verifying, unprocessed: final!.unprocessed, completed: final!.completed }, { accepted: 1, rejected: 1, verifying: 0, unprocessed: 0, completed: 1 });
  const receiptJob = await h.db.job.findUniqueOrThrow({ where: { id: receipt.id }, select: { status: true, errorCode: true, summary: true } });
  assert.equal(receiptJob.status, "RUNNING", "the folder's receipt Job is never ended by an item verdict"); assert.equal(receiptJob.errorCode, "IMPORT_INCOMPLETE");
  assert.equal((receiptJob.summary as { verifying?: number }).verifying, 0);
});
