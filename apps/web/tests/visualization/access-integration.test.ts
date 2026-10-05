import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { db } from "@/lib/db";
import { readVisualizationAccess } from "@/lib/visualization/access";

test("database visibility, lifecycle changes, and revocation are enforced on fresh reads", { skip: !process.env.DATABASE_URL }, async () => {
  const marker = randomUUID();
  const owner = await db.user.create({ data: { email: `visual-owner-${marker}@test.invalid`, name: "Owner", role: "MANAGER" } });
  const outsider = await db.user.create({ data: { email: `visual-outsider-${marker}@test.invalid`, name: "Outsider", role: "LABELER" } });
  const ownerActor = { ...owner, name: owner.name! };
  const otherActor = { ...outsider, name: outsider.name! };
  const dataset = await db.dataset.create({ data: { id: randomUUID(), name: "Completed fixture", ownerId: owner.id, metadata: { workflowStatus: "COMPLETED" } } });
  try {
    assert.equal((await readVisualizationAccess(ownerActor, dataset.id)).kind, "ready");
    assert.equal((await readVisualizationAccess(otherActor, dataset.id)).kind, "not-found");
    await db.datasetMember.create({ data: { datasetId: dataset.id, userId: outsider.id, role: "LABELER" } });
    assert.equal((await readVisualizationAccess(otherActor, dataset.id)).kind, "ready");
    await db.datasetMember.deleteMany({ where: { datasetId: dataset.id, userId: outsider.id } });
    assert.equal((await readVisualizationAccess(otherActor, dataset.id)).kind, "not-found");
    await db.dataset.update({ where: { id: dataset.id }, data: { metadata: { workflowStatus: "IN_PROGRESS" } } });
    assert.deepEqual(await readVisualizationAccess(ownerActor, dataset.id), { kind: "redirect", destination: `/workspace/${dataset.id}` });
    await db.dataset.update({ where: { id: dataset.id }, data: { metadata: { workflowStatus: "COMPLETED" }, archivedAt: new Date() } });
    assert.equal((await readVisualizationAccess(ownerActor, dataset.id)).kind, "not-found");
    await db.dataset.update({ where: { id: dataset.id }, data: { archivedAt: null, deletedAt: new Date() } });
    assert.equal((await readVisualizationAccess(ownerActor, dataset.id)).kind, "not-found");
  } finally {
    await db.dataset.delete({ where: { id: dataset.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, outsider.id] } } });
  }
});
