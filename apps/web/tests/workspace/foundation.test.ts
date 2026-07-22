import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_AUTHENTICATED_PATH, safeReturnTarget } from "@/lib/auth-redirect";
import { normalizedBoundingBoxSchema, workspaceListQuerySchema } from "@/lib/validation/image-workspace";

test("return targets accept only internal relative application paths", () => {
  assert.equal(safeReturnTarget("/workspace/cmf123?image=cmf456"), "/workspace/cmf123?image=cmf456");
  assert.equal(safeReturnTarget("https://attacker.invalid"), DEFAULT_AUTHENTICATED_PATH);
  assert.equal(safeReturnTarget("//attacker.invalid"), DEFAULT_AUTHENTICATED_PATH);
  assert.equal(safeReturnTarget("\\attacker.invalid"), DEFAULT_AUTHENTICATED_PATH);
  assert.equal(safeReturnTarget(undefined), DEFAULT_AUTHENTICATED_PATH);
});

test("normalized bounding boxes are strict, finite, positive, and bounded", () => {
  assert.equal(normalizedBoundingBoxSchema.safeParse({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }).success, true);
  assert.equal(normalizedBoundingBoxSchema.safeParse({ x: 0.9, y: 0.2, width: 0.2, height: 0.1 }).success, false);
  assert.equal(normalizedBoundingBoxSchema.safeParse({ x: 0, y: 0, width: 0, height: 0.1 }).success, false);
  assert.equal(normalizedBoundingBoxSchema.safeParse({ x: 0, y: 0, width: Number.NaN, height: 0.1 }).success, false);
  assert.equal(normalizedBoundingBoxSchema.safeParse({ x: 0, y: 0, width: 0.2, height: 0.2, extra: true }).success, false);
});

test("workspace browser contracts never use JWT or browser storage credentials", () => {
  const serialized = JSON.stringify({ returnTarget: safeReturnTarget("/datasets") });
  assert.equal(serialized.includes("jwt"), false);
  assert.equal(serialized.includes("fieldframe_session"), false);
});

test("workspace list query accepts bounded repeated status values and rejects broadening input", () => {
  assert.deepEqual(workspaceListQuerySchema.parse({ page: "2", q: "  road  ", statuses: ["NEW", "IN_PROGRESS"] }), {
    page: 2, q: "road", statuses: ["NEW", "IN_PROGRESS"],
  });
  assert.equal(workspaceListQuerySchema.safeParse({ page: "0", q: "", statuses: [] }).success, false);
  assert.equal(workspaceListQuerySchema.safeParse({ page: "1", q: "x".repeat(101), statuses: [] }).success, false);
  assert.equal(workspaceListQuerySchema.safeParse({ page: "1", q: "", statuses: ["UNKNOWN"] }).success, false);
  assert.equal(workspaceListQuerySchema.safeParse({ page: "1", q: "", statuses: [], ownerId: "browser" }).success, false);
});
