import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
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
    page: 2, q: "road", statuses: ["NEW", "IN_PROGRESS"], labelId: [], order: "desc",
  });
  assert.equal(workspaceListQuerySchema.safeParse({ page: "0", q: "", statuses: [] }).success, false);
  assert.equal(workspaceListQuerySchema.safeParse({ page: "1", q: "x".repeat(101), statuses: [] }).success, false);
  assert.equal(workspaceListQuerySchema.safeParse({ page: "1", q: "", statuses: ["UNKNOWN"] }).success, false);
  assert.equal(workspaceListQuerySchema.safeParse({ page: "1", q: "", statuses: [], ownerId: "browser" }).success, false);
});

test("workspace list query accepts the new Asset Browser filter/sort params (022) and keeps them optional", () => {
  const withFilters = workspaceListQuerySchema.parse({
    page: "1", q: "", statuses: [],
    filterModality: "IMAGE", labelId: ["cly0000000000000000000000"], assignedToId: "cly0000000000000000000001",
    createdFrom: "2026-01-01T00:00:00.000Z", createdTo: "2026-12-31T23:59:59.000Z", sort: "createdAt", order: "asc",
  });
  assert.equal(withFilters.filterModality, "IMAGE");
  assert.deepEqual(withFilters.labelId, ["cly0000000000000000000000"]);
  assert.equal(withFilters.sort, "createdAt");
  assert.equal(withFilters.order, "asc");
  assert.equal(workspaceListQuerySchema.safeParse({ page: "1", q: "", statuses: [], sort: "annotationCount" }).success, false);
  assert.equal(workspaceListQuerySchema.safeParse({ page: "1", q: "", statuses: [], filterModality: "NOT_A_MODALITY" }).success, false);
});
