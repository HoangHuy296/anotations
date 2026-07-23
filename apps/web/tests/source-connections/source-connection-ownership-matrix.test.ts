import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { RepoAuthType, RepoProvider, SourceConnectionStatus } from "@internal/db";

import { db } from "@/lib/db";
import { encryptSourceToken } from "@/lib/source-connection-crypto";
import {
  assertNoSourceSecret,
  createAdminAndLogin,
  request,
  signupAndLogin,
  sourceConnectionHttpEnabled,
  sourceConnectionHttpSkipReason,
} from "./helpers";

const cleanupUserIds: string[] = [];
after(async () => {
  await db.dataset.deleteMany({ where: { ownerId: { in: cleanupUserIds } } });
  await db.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

async function safeRead(path: string, cookie: string, status: number) {
  const response = await request(path, { headers: { Cookie: cookie } });
  assert.equal(response.status, status);
  const body = await response.text();
  assertNoSourceSecret(body, ["ownership-token-sentinel", "ownership-private.test"]);
}

test("GET by ID applies owner/admin scope and conceals foreign, malformed, and unknown identifiers", { skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const foreign = await signupAndLogin();
  const admin = await createAdminAndLogin();
  const ownerUser = await db.user.findUniqueOrThrow({ where: { email: owner.email }, select: { id: true } });
  const foreignUser = await db.user.findUniqueOrThrow({ where: { email: foreign.email }, select: { id: true } });
  cleanupUserIds.push(ownerUser.id, foreignUser.id, admin.userId);
  const connection = await db.sourceConnection.create({
    data: {
      userId: ownerUser.id,
      provider: RepoProvider.GITEA,
      authType: RepoAuthType.TOKEN,
      baseUrl: "https://ownership-private.test",
      tokenEncrypted: encryptSourceToken("ownership-token-sentinel"),
      status: SourceConnectionStatus.ACTIVE,
      name: `ownership-${randomBytes(4).toString("hex")}`,
    },
    select: { id: true },
  });

  await safeRead(`/api/source-connections/${connection.id}`, owner.cookie, 200);
  await safeRead(`/api/source-connections/${connection.id}`, admin.cookie, 200);
  await safeRead(`/api/source-connections/${connection.id}`, foreign.cookie, 404);
  await safeRead("/api/source-connections/not-a-source-connection-id", owner.cookie, 404);
  await safeRead("/api/source-connections/cm00000000000000000000000", owner.cookie, 404);
});
