import assert from "node:assert/strict";
import test, { after } from "node:test";

import { db } from "@/lib/db";
import {
  assertNoSourceSecret,
  controlledGiteaInput,
  createAdminAndLogin,
  request,
  signupAndLogin,
  sourceConnectionHttpEnabled,
  sourceConnectionHttpSkipReason,
} from "./helpers";

const cleanupUserIds: string[] = [];

after(async () => {
  if (cleanupUserIds.length) await db.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

test("authenticated HTTP create/read matrix returns safe DTOs and conceals foreign identifiers", {
  skip: sourceConnectionHttpEnabled ? false : sourceConnectionHttpSkipReason,
}, async () => {
  const owner = await signupAndLogin();
  const created = await request("/api/source-connections", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify(controlledGiteaInput()),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { data: { connection: { id: string } } };
  assertNoSourceSecret(createdBody, [process.env.SOURCE_CONNECTION_GITEA_TOKEN ?? ""]);
  const id = createdBody.data.connection.id;
  const ownerUser = await db.user.findUniqueOrThrow({ where: { email: owner.email }, select: { id: true } });
  cleanupUserIds.push(ownerUser.id);

  const [list, one] = await Promise.all([
    request("/api/source-connections", { headers: { Cookie: owner.cookie } }),
    request(`/api/source-connections/${id}`, { headers: { Cookie: owner.cookie } }),
  ]);
  assert.equal(list.status, 200);
  assert.equal(one.status, 200);
  assertNoSourceSecret(await list.json(), [process.env.SOURCE_CONNECTION_GITEA_TOKEN ?? ""]);
  assertNoSourceSecret(await one.json(), [process.env.SOURCE_CONNECTION_GITEA_TOKEN ?? ""]);

  const foreign = await signupAndLogin();
  const foreignRead = await request(`/api/source-connections/${id}`, { headers: { Cookie: foreign.cookie } });
  assert.equal(foreignRead.status, 404);
  const foreignUser = await db.user.findUniqueOrThrow({ where: { email: foreign.email }, select: { id: true } });
  cleanupUserIds.push(foreignUser.id);

  const malformed = await request("/api/source-connections/not-a-cuid", { headers: { Cookie: owner.cookie } });
  assert.equal(malformed.status, 404);
  const unknown = await request("/api/source-connections/cm00000000000000000000000", { headers: { Cookie: owner.cookie } });
  assert.equal(unknown.status, 404);

  const admin = await createAdminAndLogin();
  cleanupUserIds.push(admin.userId);
  const adminRead = await request(`/api/source-connections/${id}`, { headers: { Cookie: admin.cookie } });
  assert.equal(adminRead.status, 200);
  assertNoSourceSecret(await adminRead.json(), [process.env.SOURCE_CONNECTION_GITEA_TOKEN ?? ""]);
});
