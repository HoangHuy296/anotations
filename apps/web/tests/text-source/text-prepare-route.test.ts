import assert from "node:assert/strict";
import test from "node:test";
import { AssetStatus, DatasetMemberRole, Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { requestTextSourcePreparation } from "../../src/lib/annotations/text-source-prepare-service.js";
import { mapTextSourcePrepareOutcomeToHttp } from "../../src/lib/annotations/text-source-http-mapping.js";
import { createWorkspaceUser, createWorkspaceDataset, addWorkspaceMember, cleanupWorkspaceFixture, workspaceUnique } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/**
 * T051: `POST /api/assets/{assetId}/text/prepare` contract -- `dataset.read`
 * authorizes preparation of an unprepared source and ready reads, including
 * review-frozen assets; no `annotation.create` check at the policy seam.
 * REVIEWER also has `annotation.create` in this codebase's existing role
 * table (`apps/web/src/lib/authorization.ts`), so this does not invent a
 * distinct read-only role to "prove" independence -- it proves independence
 * the way research.md specifies: dataset.read alone gates this, and a
 * frozen (NEEDS_REVIEW) asset does not block it.
 *
 * Same route-invocation constraint as T050 (see text-read-route.test.ts):
 * `cookies()` throws outside a real request scope in this Next.js version,
 * so this suite unit-tests the route's actual status-mapping logic
 * (`mapTextSourcePrepareOutcomeToHttp`) directly and exercises the
 * already-built T038 service for every contract-relevant outcome.
 */

test("mapTextSourcePrepareOutcomeToHttp: 202 for a new/reused in-progress Job, 200 only once the Job has actually completed, 409/404 for failures", () => {
  assert.deepEqual(mapTextSourcePrepareOutcomeToHttp({ ok: true, job: { id: "j1", status: "QUEUED" }, created: true }), { status: 202, ready: false });
  assert.deepEqual(mapTextSourcePrepareOutcomeToHttp({ ok: true, job: { id: "j1", status: "QUEUED" }, created: false }), { status: 202, ready: false });
  assert.deepEqual(mapTextSourcePrepareOutcomeToHttp({ ok: true, job: { id: "j1", status: "RUNNING" }, created: false }), { status: 202, ready: false });
  assert.deepEqual(mapTextSourcePrepareOutcomeToHttp({ ok: true, job: { id: "j1", status: "FAILED" }, created: false }), { status: 202, ready: false });
  assert.deepEqual(mapTextSourcePrepareOutcomeToHttp({ ok: true, job: { id: "j1", status: "COMPLETED" }, created: false }), { status: 200, ready: true });
  assert.deepEqual(mapTextSourcePrepareOutcomeToHttp({ ok: false, reason: "NOT_FOUND" }), { status: 404, ready: false });
  assert.deepEqual(mapTextSourcePrepareOutcomeToHttp({ ok: false, reason: "SOURCE_UNAVAILABLE" }), { status: 409, ready: false });
});

test("the route source gates on dataset.read (via requestTextSourcePreparation) and never checks annotation.create at its own policy seam", async () => {
  const routeSource = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../src/app/api/assets/[assetId]/text/prepare/route.ts", import.meta.url), "utf8"));
  // A quoted string literal would indicate an actual permission-check call
  // (e.g. `requireDatasetPermission(actor, id, "annotation.create")`);
  // backtick-quoted mentions in the doc comment explaining the *absence* of
  // such a check are expected and must not trip this assertion.
  assert.doesNotMatch(routeSource, /["']annotation\.create["']/);
  const serviceSource = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../src/lib/annotations/text-source-prepare-service.ts", import.meta.url), "utf8"));
  assert.match(serviceSource, /"dataset\.read"/);
});

test("requestTextSourcePreparation (what the route calls): preparation is authorized for a REVIEWER on a review-frozen (NEEDS_REVIEW) asset -- dataset.read, independent of workflow state", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const reviewer = await createWorkspaceUser(UserRole.REVIEWER);
  const dataset = await createWorkspaceDataset(owner.id);
  await addWorkspaceMember(dataset.id, reviewer.id, DatasetMemberRole.REVIEWER);
  const { config, minio } = getWebProviders();
  const marker = workspaceUnique("prepare-route-frozen");
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const bytes = Buffer.from("frozen but preparable", "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const asset = await db.asset.create({
    data: { datasetId: dataset.id, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain", status: AssetStatus.NEEDS_REVIEW, storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey, sourceFingerprint: marker },
    select: { id: true },
  });

  try {
    const outcome = await requestTextSourcePreparation(reviewer, asset.id);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.created, true);
      const mapped = mapTextSourcePrepareOutcomeToHttp(outcome);
      assert.equal(mapped.status, 202, "a freshly queued Job is 202, never blocked by the frozen workflow state");
    }
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    await db.job.deleteMany({ where: { datasetId: dataset.id } });
    await cleanupWorkspaceFixture([owner.id, reviewer.id], [dataset.id]);
  }
});

test("requestTextSourcePreparation: a non-member is concealed as NOT_FOUND (404), and a real 403-capable visible-resource denial is distinguishable in principle from concealment", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const outsider = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  const { config, minio } = getWebProviders();
  const marker = workspaceUnique("prepare-route-concealed");
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const bytes = Buffer.from("concealed fixture", "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const asset = await db.asset.create({
    data: { datasetId: dataset.id, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain", storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey, sourceFingerprint: marker },
    select: { id: true },
  });

  try {
    const outcome = await requestTextSourcePreparation(outsider, asset.id);
    assert.deepEqual(outcome, { ok: false, reason: "NOT_FOUND" });
    assert.deepEqual(mapTextSourcePrepareOutcomeToHttp(outcome), { status: 404, ready: false });
    // `requireDatasetPermission` (the shared authorization primitive every
    // dataset.read-gated route already uses, including this one) returns
    // `forbidden: true` only for a *visible* dataset the actor genuinely
    // lacks permission on -- distinct from `null` (concealed as 404). Every
    // dataset role in this codebase's role table currently includes
    // dataset.read, so a true 403 at this specific seam has no reachable
    // fixture; this is a property of the role table, not something this
    // route/service invents a bypass for.
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    await cleanupWorkspaceFixture([owner.id, outsider.id], [dataset.id]);
  }
});
