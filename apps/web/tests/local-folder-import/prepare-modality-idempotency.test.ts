import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";
import { UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { prepareLocalFolderImport } from "@/lib/imports/prepare-local-folder-import";
import { startLocalFolderImportSchema } from "@/lib/validation/local-folder-import";
import { createWorkspaceUser } from "../workspace/helpers.js";
import { buildSafeManifest } from "./helpers.js";

/**
 * T014 (folder half): the service that backs POST /api/imports/local-folder is called directly with a real manager
 * user (real authorization helper, real Prisma, disposable DB/Redis). The idempotency identity of a start request must
 * include the explicit modality: replaying the same key with the same modality is a replay, changing the modality while
 * reusing the key is IDEMPOTENCY_KEY_CONFLICT and creates nothing. (The repository half is covered by
 * tests/repository-import-request/acceptance-service.test.ts, which asserts creationRequestHash differs by modality.)
 */
const created = { users: [] as string[] };
const key = () => randomBytes(20).toString("hex");
const start = (modality: "IMAGE" | "VIDEO" | "AUDIO" | "TEXT", idempotencyKey: string, name = `t014-${idempotencyKey.slice(0, 8)}`, path = "folder/readme.txt") =>
  startLocalFolderImportSchema.parse({ name, modality, idempotencyKey, items: buildSafeManifest([{ logicalPath: path, contentType: "text/plain" }]) });

after(async () => {
  try { await db.user.deleteMany({ where: { id: { in: created.users } } }); } catch { /* disposable teardown removes the rest */ }
});

test("same idempotency key + same modality replays the existing preparation without a second Dataset or Job", async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER); created.users.push(owner.id);
  const idempotencyKey = key();
  const first = await prepareLocalFolderImport(owner, start("IMAGE", idempotencyKey));
  assert.equal(first.ok, true);
  const second = await prepareLocalFolderImport(owner, start("IMAGE", idempotencyKey));
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(("replayed" in second) && second.replayed, true);
  assert.equal(second.preparation.id, first.preparation.id);
  assert.equal(await db.preparedImport.count({ where: { createdById: owner.id } }), 1);
  assert.equal(await db.dataset.count({ where: { ownerId: owner.id } }), 1);
  assert.equal(await db.job.count({ where: { createdById: owner.id } }), 1);
});

test("reusing the key with a different modality is IDEMPOTENCY_KEY_CONFLICT and creates and changes nothing", async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER); created.users.push(owner.id);
  const idempotencyKey = key();
  const first = await prepareLocalFolderImport(owner, start("IMAGE", idempotencyKey));
  assert.equal(first.ok, true);
  const before = JSON.stringify(await db.dataset.findMany({ where: { ownerId: owner.id }, orderBy: { id: "asc" } }), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  for (const modality of ["VIDEO", "AUDIO", "TEXT"] as const) {
    const conflict = await prepareLocalFolderImport(owner, start(modality, idempotencyKey));
    assert.equal(conflict.ok, false, modality);
    if (!conflict.ok) { assert.equal(conflict.status, 409); assert.equal("code" in conflict && conflict.code, "IDEMPOTENCY_KEY_CONFLICT"); }
  }
  assert.equal(await db.preparedImport.count({ where: { createdById: owner.id } }), 1);
  assert.equal(await db.dataset.count({ where: { ownerId: owner.id } }), 1);
  assert.equal(await db.job.count({ where: { createdById: owner.id } }), 1);
  assert.equal(JSON.stringify(await db.dataset.findMany({ where: { ownerId: owner.id }, orderBy: { id: "asc" } }), (_k, v) => (typeof v === "bigint" ? v.toString() : v)), before, "the original Dataset row (including its fixed modality) is untouched");
  assert.equal((await db.dataset.findFirstOrThrow({ where: { ownerId: owner.id }, select: { modality: true } })).modality, "IMAGE");
});

test("the same key from a different user is independent (key identity is scoped to the creator)", async () => {
  const a = await createWorkspaceUser(UserRole.MANAGER); const b = await createWorkspaceUser(UserRole.MANAGER); created.users.push(a.id, b.id);
  const idempotencyKey = key();
  assert.equal((await prepareLocalFolderImport(a, start("IMAGE", idempotencyKey))).ok, true);
  const other = await prepareLocalFolderImport(b, start("VIDEO", idempotencyKey));
  assert.equal(other.ok, true);
  assert.equal((await db.dataset.findFirstOrThrow({ where: { ownerId: b.id }, select: { modality: true } })).modality, "VIDEO");
});

test("a changed manifest with the same key and modality is still a conflict (existing behaviour preserved)", async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER); created.users.push(owner.id);
  const idempotencyKey = key();
  assert.equal((await prepareLocalFolderImport(owner, start("TEXT", idempotencyKey))).ok, true);
  const changed = await prepareLocalFolderImport(owner, start("TEXT", idempotencyKey, undefined, "folder/other.txt"));
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal("code" in changed && changed.code, "IDEMPOTENCY_KEY_CONFLICT");
});
