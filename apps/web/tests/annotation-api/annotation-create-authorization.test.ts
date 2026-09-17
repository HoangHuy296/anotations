import assert from "node:assert/strict";
import test from "node:test";
import { db } from "@/lib/db";
import { mutateImageAnnotations } from "@/lib/annotations/annotation-service";

test("membership disappearing after the initial read prevents annotation creation", async (t) => {
  const originalTransaction = db.$transaction;
  const originalAssetRead = db.asset.findFirst;
  const originalDatasetRead = db.dataset.findFirst;
  let accessReads = 0;
  Object.assign(db.asset, { findFirst: async () => ({ id: "asset", datasetId: "dataset", modality: "IMAGE" }) });
  Object.assign(db.dataset, { findFirst: async () => ++accessReads === 1
    ? { id: "dataset", ownerId: "owner", members: [{ role: "LABELER" }] }
    : null });
  t.after(() => {
    Object.assign(db, { $transaction: originalTransaction });
    Object.assign(db.asset, { findFirst: originalAssetRead });
    Object.assign(db.dataset, { findFirst: originalDatasetRead });
  });
  const transaction = t.mock.fn(async () => { throw new Error("No write transaction is allowed after access disappears"); });
  Object.assign(db, { $transaction: transaction });
  const result = await mutateImageAnnotations({ id: "labeler", name: "Labeler", email: "labeler@example.test", role: "LABELER" }, "asset", {
    creates: [{ id: "annotation", type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }], updates: [], deletes: [],
  });
  assert.deepEqual(result, { ok: false, reason: "NOT_FOUND" });
  assert.equal(transaction.mock.callCount(), 0);
});
