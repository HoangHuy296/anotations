import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { getActorFromSessionToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { createFixture, hasIntegrationDatabase } from "./helpers";

test("old, revoked, and expired opaque credentials cannot resolve an actor", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createFixture();
  try {
    const oldToken = randomBytes(32).toString("base64url");
    const replacement = randomBytes(32).toString("base64url");
    const session = await db.authSession.create({ data: { userId: fixture.actors.owner.id, refreshTokenHash: createHash("sha256").update(oldToken).digest("hex"), expiresAt: new Date(Date.now() + 60_000) } });
    await db.authSession.update({ where: { id: session.id }, data: { refreshTokenHash: createHash("sha256").update(replacement).digest("hex") } });
    assert.equal(await getActorFromSessionToken(oldToken), null);
    assert.equal((await getActorFromSessionToken(replacement))?.id, fixture.actors.owner.id);
    await db.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    assert.equal(await getActorFromSessionToken(replacement), null);
  } finally { await fixture.cleanup(); }
});
