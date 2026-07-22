import assert from "node:assert/strict";
import test from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { createAuthorizedExportJob } from "@/lib/exports/export-service";
import { readAuthorizedExportJob } from "@/lib/exports/authorization";
import { cancelAuthorizedJob } from "@/lib/jobs/authorization";
import { db } from "@/lib/db";
import { createJobQueueFixture, createQueueInspector, queueIntegrationSkipReason } from "./helpers";

test("export role, cross-Dataset, and denial side-effect matrix follows canonical permissions", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  const queue = createQueueInspector();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const extraUsers = await Promise.all([
    db.user.create({ data: { email: `manager-${suffix}@phase012.test`, role: UserRole.MANAGER }, select: { id: true, email: true, name: true, role: true } }),
    db.user.create({ data: { email: `reviewer-${suffix}@phase012.test`, role: UserRole.REVIEWER }, select: { id: true, email: true, name: true, role: true } }),
    db.user.create({ data: { email: `admin-${suffix}@phase012.test`, role: UserRole.ADMIN }, select: { id: true, email: true, name: true, role: true } }),
  ]);
  const [managerUser, reviewerUser, adminUser] = extraUsers;
  const actor = (user: typeof managerUser) => ({ ...user, name: user.name ?? user.email });
  const manager = actor(managerUser);
  const reviewer = actor(reviewerUser);
  const admin = actor(adminUser);
  let jobId = "";
  try {
    await db.datasetMember.createMany({ data: [
      { datasetId: fixture.datasetId, userId: manager.id, role: DatasetMemberRole.MANAGER },
      { datasetId: fixture.datasetId, userId: reviewer.id, role: DatasetMemberRole.REVIEWER },
    ] });
    const beforeDenial = await Promise.all([
      db.job.count({ where: { datasetId: fixture.datasetId } }),
      db.jobEvent.count({ where: { job: { datasetId: fixture.datasetId } } }),
      db.asset.count({ where: { datasetId: fixture.datasetId } }),
      db.label.count({ where: { datasetId: fixture.datasetId } }),
      db.annotation.count({ where: { datasetId: fixture.datasetId } }),
      db.dataset.findUniqueOrThrow({ where: { id: fixture.datasetId }, select: { updatedAt: true } }),
    ]);
    assert.deepEqual(await createAuthorizedExportJob(fixture.labeler, { datasetId: fixture.datasetId }), { ok: false, status: 403 });
    assert.deepEqual(await createAuthorizedExportJob(fixture.outsider, { datasetId: fixture.datasetId }), { ok: false, status: 404 });
    const afterDenial = await Promise.all([
      db.job.count({ where: { datasetId: fixture.datasetId } }),
      db.jobEvent.count({ where: { job: { datasetId: fixture.datasetId } } }),
      db.asset.count({ where: { datasetId: fixture.datasetId } }),
      db.label.count({ where: { datasetId: fixture.datasetId } }),
      db.annotation.count({ where: { datasetId: fixture.datasetId } }),
      db.dataset.findUniqueOrThrow({ where: { id: fixture.datasetId }, select: { updatedAt: true } }),
    ]);
    assert.deepEqual(afterDenial, beforeDenial);

    for (const allowed of [fixture.owner, manager, reviewer, admin]) {
      const result = await createAuthorizedExportJob(allowed, { datasetId: fixture.datasetId });
      assert.equal(result.ok, true);
      if (result.ok) jobId = result.job.id;
    }
    assert.ok(jobId);
    assert.equal(await db.job.count({ where: { datasetId: fixture.datasetId, type: "EXPORT_DATASET" } }), 1);
    assert.deepEqual(await readAuthorizedExportJob(fixture.outsider, jobId), { ok: false, status: 404 });
    assert.equal((await readAuthorizedExportJob(fixture.labeler, jobId)).ok, true);
    assert.deepEqual(await cancelAuthorizedJob(fixture.labeler, jobId), { ok: false, status: 403 });
    assert.deepEqual(await cancelAuthorizedJob(reviewer, jobId), { ok: false, status: 403 });
    assert.equal((await cancelAuthorizedJob(manager, jobId)).ok, true);
  } finally {
    if (jobId) await queue.remove(jobId);
    await queue.close();
    await fixture.cleanup();
    await db.user.deleteMany({ where: { id: { in: extraUsers.map((user) => user.id) } } });
  }
});
