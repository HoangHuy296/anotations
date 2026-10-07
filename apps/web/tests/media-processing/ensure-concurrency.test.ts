import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { Modality, StorageProvider, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { ensureMediaProcessingJob } from "@/lib/media-processing/ensure-media-processing-job";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "../workspace/helpers";

// The workspace engines request per-Asset processing whenever an unprocessed VIDEO/AUDIO Asset opens (rerender, two tabs, navigate away/back). The server
// boundary must therefore be idempotent under concurrency: every request succeeds, all of them resolve to ONE durable Job, and none surfaces a 500.
const enabled = Boolean(process.env.DATABASE_URL);
const users: string[] = [];
const datasets: string[] = [];
after(async () => { if (users.length || datasets.length) await cleanupWorkspaceFixture(users, datasets); });

async function videoFixture() {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id, Modality.VIDEO);
  users.push(owner.id); datasets.push(dataset.id);
  const n = workspaceUnique("media-concurrency");
  const asset = await db.asset.create({
    data: { datasetId: dataset.id, modality: Modality.VIDEO, filename: "v.mp4", mimeType: "video/mp4", sourceFingerprint: n, sizeBytes: BigInt(4321), storageProvider: StorageProvider.MINIO, storageBucket: "test-bucket", storageKey: `media-concurrency/${n}.mp4` },
    select: { id: true },
  });
  return { actor: { id: owner.id, email: owner.email, name: owner.name, role: owner.role }, assetId: asset.id };
}

test("parallel requests for one Asset all succeed and resolve to exactly one durable Job", { skip: !enabled }, async () => {
  for (let round = 0; round < 3; round += 1) {
    const { actor, assetId } = await videoFixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureMediaProcessingJob(actor, { assetId, type: "EXTRACT_VIDEO_METADATA" }).then((result) => ({ result }), (error: unknown) => ({ error }))));
    const failures = results.filter((entry) => "error" in entry);
    assert.equal(failures.length, 0, `round ${round}: a concurrent request threw (${failures.map((entry) => (entry as { error: { code?: string } }).error?.code ?? "unknown").join(",")})`);
    const ok = results.map((entry) => (entry as { result: Awaited<ReturnType<typeof ensureMediaProcessingJob>> }).result);
    assert.ok(ok.every((result) => result.ok), `round ${round}: every request is accepted`);
    const jobIds = new Set(ok.map((result) => (result.ok ? result.job.id : "")));
    assert.equal(jobIds.size, 1, `round ${round}: one Job id`);
    assert.equal(ok.filter((result) => result.ok && !result.reused).length, 1, `round ${round}: exactly one request created it`);
    assert.equal(await db.job.count({ where: { id: { in: [...jobIds] } } }), 1, `round ${round}: the one Job is durable`);
  }
});
