import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { UserRole } from "@internal/db";
import { db } from "@/lib/db";
import { datasetDestination, projectDatasetWorkflowStatus } from "@/lib/datasets/dataset-destination";
import { readVisualizationAccess } from "@/lib/visualization/access";

const id = "00000000-0000-4000-8000-000000000001";
const actor = { id: "owner", email: "owner@test.invalid", name: "Owner", role: UserRole.MANAGER };

test("only exact COMPLETED routes to visualization, independent of asset/annotation status", () => {
  assert.equal(datasetDestination(id, "COMPLETED"), `/datasets/visualize/${id}`);
  for (const status of ["IN_PROGRESS", "REVIEWED", "DRAFT", "completed", " COMPLETED", null, undefined, {}, 1]) {
    assert.equal(datasetDestination(id, status), `/workspace/${id}`);
  }
  const projected = projectDatasetWorkflowStatus({ id, metadata: { workflowStatus: "COMPLETED", privateUrl: "must-not-leak" } });
  assert.deepEqual(projected, { id, workflowStatus: "COMPLETED" });
  for (const metadata of [null, [], {}, { status: "COMPLETED" }, { workflowStatus: "DRAFT", assetStatus: "COMPLETED", annotationStatus: "COMPLETED" }]) {
    assert.equal(projectDatasetWorkflowStatus({ metadata }).workflowStatus, "IN_PROGRESS");
  }
});

test("access is authorized before metadata reads and each invocation observes reopening", async (t) => {
  let status = "COMPLETED";
  let visible = true;
  let reads = 0;
  const original = db.dataset.findFirst;
  t.after(() => { db.dataset.findFirst = original; });
  db.dataset.findFirst = (async (args: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
    reads++;
    assert.equal(args.where.deletedAt, null);
    assert.equal(args.where.archivedAt, null);
    assert.deepEqual(args.where.OR, [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }]);
    if (!visible) return null;
    return args.select.metadata
      ? { id, name: "Real dataset", metadata: { workflowStatus: status, privateUrl: "hidden" } }
      : { id, ownerId: actor.id, members: [] };
  }) as unknown as typeof db.dataset.findFirst;
  assert.deepEqual(await readVisualizationAccess(null, id), { kind: "not-found" });
  assert.deepEqual(await readVisualizationAccess(actor, "invalid"), { kind: "not-found" });
  assert.equal(reads, 0);
  assert.deepEqual(await readVisualizationAccess(actor, id), { kind: "ready", dataset: { id, name: "Real dataset" } });
  for (const value of ["IN_PROGRESS", "REVIEWED", "DRAFT"]) {
    status = value;
    assert.deepEqual(await readVisualizationAccess(actor, id), { kind: "redirect", destination: `/workspace/${id}` });
  }
  visible = false;
  const before = reads;
  assert.deepEqual(await readVisualizationAccess(actor, id), { kind: "not-found" });
  assert.equal(reads, before + 1, "denied access never reads workflow metadata");
});

test("CUIDs, membership and admins use existing read permission; disappearance fails closed", async (t) => {
  const cuid = "clxxxxxxxxxxxxxxxxxxxxxxx";
  let disappeared = false;
  const original = db.dataset.findFirst;
  t.after(() => { db.dataset.findFirst = original; });
  db.dataset.findFirst = (async (args: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
    if (args.select.metadata) return disappeared ? null : { id: cuid, name: "Member dataset", metadata: { workflowStatus: "COMPLETED" } };
    return { id: cuid, ownerId: "other", members: [{ role: "LABELER" }] };
  }) as unknown as typeof db.dataset.findFirst;
  assert.equal((await readVisualizationAccess(actor, cuid)).kind, "ready");
  assert.equal((await readVisualizationAccess({ ...actor, role: UserRole.ADMIN }, cuid)).kind, "ready");
  disappeared = true;
  assert.deepEqual(await readVisualizationAccess(actor, cuid), { kind: "not-found" });
});
