import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import {
  RepoAuthType,
  RepoProvider,
  SourceConnectionStatus,
  UserRole,
} from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireOwnedSourceConnection } from "@/lib/authorization";
import { db } from "@/lib/db";
import { getSourceConnection } from "@/lib/source-connection-service";
import { encryptSourceToken } from "@/lib/source-connection-crypto";
import { sourceConnectionIdSchema } from "@/lib/validation/source-connection";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);
const suffix = randomBytes(8).toString("hex");
const createdUserIds: string[] = [];
let owner: RequestActor;
let admin: RequestActor;
let foreign: RequestActor;
let activeConnectionId = "";

function actor(id: string, role: UserRole, email: string): RequestActor {
  return { id, role, email, name: email };
}

before(async () => {
  if (!hasIntegrationDatabase) return;
  process.env.SOURCE_CONNECTION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const [ownerUser, adminUser, foreignUser] = await Promise.all([
    db.user.create({ data: { email: `source-owner-${suffix}@test.invalid`, role: UserRole.MANAGER } }),
    db.user.create({ data: { email: `source-admin-${suffix}@test.invalid`, role: UserRole.ADMIN } }),
    db.user.create({ data: { email: `source-foreign-${suffix}@test.invalid`, role: UserRole.MANAGER } }),
  ]);
  createdUserIds.push(ownerUser.id, adminUser.id, foreignUser.id);
  owner = actor(ownerUser.id, ownerUser.role, ownerUser.email);
  admin = actor(adminUser.id, adminUser.role, adminUser.email);
  foreign = actor(foreignUser.id, foreignUser.role, foreignUser.email);

  const active = await db.sourceConnection.create({
    data: {
      userId: ownerUser.id,
      provider: RepoProvider.GITEA,
      authType: RepoAuthType.TOKEN,
      baseUrl: "https://source-authorization.test",
      tokenEncrypted: encryptSourceToken("fixture-token"),
      status: SourceConnectionStatus.ACTIVE,
    },
  });
  activeConnectionId = active.id;

  await db.sourceConnection.createMany({
    data: [
      {
        userId: ownerUser.id,
        provider: RepoProvider.GITEA,
        authType: RepoAuthType.TOKEN,
        baseUrl: "https://source-revoked.test",
        status: SourceConnectionStatus.REVOKED,
        revokedAt: new Date(),
      },
      {
        userId: ownerUser.id,
        provider: RepoProvider.GITEA,
        authType: RepoAuthType.TOKEN,
        baseUrl: "https://source-expired.test",
        tokenEncrypted: encryptSourceToken("expired-fixture-token"),
        status: SourceConnectionStatus.EXPIRED,
        tokenExpiresAt: new Date(Date.now() - 1_000),
      },
    ],
  });
});

after(async () => {
  if (!hasIntegrationDatabase || !createdUserIds.length) return;
  await db.sourceConnection.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

test("source connection owner/admin resolution conceals foreign, revoked, and expired records", { skip: !hasIntegrationDatabase }, async () => {
  const owned = await getSourceConnection(owner, activeConnectionId);
  assert.equal(owned?.id, activeConnectionId);
  assert.equal("baseUrl" in (owned ?? {}), false);

  const adminRead = await getSourceConnection(admin, activeConnectionId);
  assert.equal(adminRead?.id, activeConnectionId);

  assert.equal(await getSourceConnection(foreign, activeConnectionId), null);
  assert.equal(await requireOwnedSourceConnection(foreign, activeConnectionId), null);
  assert.equal((await requireOwnedSourceConnection(owner, activeConnectionId))?.id, activeConnectionId);

  const inactive = await db.sourceConnection.findMany({
    where: { userId: owner.id, id: { not: activeConnectionId } },
    select: { id: true, status: true },
  });
  const revoked = inactive.find((connection) => connection.status === SourceConnectionStatus.REVOKED);
  const expired = inactive.find((connection) => connection.status === SourceConnectionStatus.EXPIRED);
  assert.ok(revoked && expired);
  assert.equal(await getSourceConnection(owner, revoked.id), null);
  assert.equal((await getSourceConnection(owner, expired.id))?.status, SourceConnectionStatus.EXPIRED);
  assert.equal(await requireOwnedSourceConnection(owner, expired.id), null);
});

test("malformed and unknown source connection identifiers are not valid resource references", { skip: !hasIntegrationDatabase }, async () => {
  assert.equal(sourceConnectionIdSchema.safeParse("not-a-cuid").success, false);
  const unknownId = "cm00000000000000000000000";
  assert.equal(sourceConnectionIdSchema.safeParse(unknownId).success, true);
  assert.equal(await getSourceConnection(owner, unknownId), null);
  assert.equal(await requireOwnedSourceConnection(owner, unknownId), null);
});
