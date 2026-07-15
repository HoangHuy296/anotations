import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { hashPassword, getActorFromSessionToken, verifyPassword } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { createFixture, hasIntegrationDatabase } from "./helpers";

test("password hashes verify without retaining plaintext", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
});

test("session resolution rejects revoked and expired credentials", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createFixture();
  try {
    const token = randomBytes(32).toString("base64url");
    const refreshTokenHash = createHash("sha256").update(token).digest("hex");
    const session = await db.authSession.create({ data: { userId: fixture.actors.owner.id, refreshTokenHash, expiresAt: new Date(Date.now() + 60_000) } });
    assert.equal((await getActorFromSessionToken(token))?.id, fixture.actors.owner.id);
    await db.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    assert.equal(await getActorFromSessionToken(token), null);
    const expired = randomBytes(32).toString("base64url");
    await db.authSession.create({ data: { userId: fixture.actors.owner.id, refreshTokenHash: createHash("sha256").update(expired).digest("hex"), expiresAt: new Date(Date.now() - 1_000) } });
    assert.equal(await getActorFromSessionToken(expired), null);
  } finally { await fixture.cleanup(); }
});

test("dataset authorization maps outsider to hidden and unallowed member to forbidden", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createFixture();
  try {
    assert.equal(await requireDatasetPermission(fixture.actors.outsider, fixture.datasetId, "dataset.read"), null);
    const denied = await requireDatasetPermission(fixture.actors.labeler, fixture.datasetId, "label.manage");
    assert.equal(denied?.forbidden, true);
  } finally { await fixture.cleanup(); }
});
