import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { RepoAuthType, RepoProvider, SourceConnectionStatus } from "@internal/db";

import { db } from "@/lib/db";
import { encryptSourceToken } from "@/lib/source-connection-crypto";
import {
  assertNoSourceSecret,
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

async function responseText(response: Response) {
  const text = await response.text();
  assertNoSourceSecret(text, ["source-token-sentinel", "private-source.test"]);
  return text;
}

test("source connection HTTP responses and denial errors redact all credentials and private details", { skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const foreign = await signupAndLogin();
  const ownerUser = await db.user.findUniqueOrThrow({ where: { email: owner.email }, select: { id: true } });
  const foreignUser = await db.user.findUniqueOrThrow({ where: { email: foreign.email }, select: { id: true } });
  cleanupUserIds.push(ownerUser.id, foreignUser.id);
  const connection = await db.sourceConnection.create({
    data: {
      userId: ownerUser.id,
      provider: RepoProvider.GITEA,
      authType: RepoAuthType.TOKEN,
      baseUrl: "https://private-source.test",
      tokenEncrypted: encryptSourceToken("source-token-sentinel"),
      status: SourceConnectionStatus.ACTIVE,
      name: `redaction-${randomBytes(4).toString("hex")}`,
    },
    select: { id: true },
  });

  const list = await request("/api/source-connections", { headers: { Cookie: owner.cookie } });
  assert.equal(list.status, 200);
  await responseText(list);

  const get = await request(`/api/source-connections/${connection.id}`, { headers: { Cookie: owner.cookie } });
  assert.equal(get.status, 200);
  await responseText(get);

  const malformed = await request("/api/source-connections", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ provider: "GITEA", baseUrl: "http://127.0.0.1", token: "source-token-sentinel" }),
  });
  assert.equal(malformed.status, 400);
  await responseText(malformed);

  const foreignGet = await request(`/api/source-connections/${connection.id}`, { headers: { Cookie: foreign.cookie } });
  assert.equal(foreignGet.status, 404);
  await responseText(foreignGet);

  const foreignDelete = await request(`/api/source-connections/${connection.id}`, { method: "DELETE", headers: { Cookie: foreign.cookie } });
  assert.equal(foreignDelete.status, 404);
  await responseText(foreignDelete);

  const deleteResponse = await request(`/api/source-connections/${connection.id}`, { method: "DELETE", headers: { Cookie: owner.cookie } });
  assert.equal(deleteResponse.status, 204);
  assert.equal(await deleteResponse.text(), "");
});
