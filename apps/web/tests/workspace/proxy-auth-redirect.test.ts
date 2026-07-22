import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { NextRequest } from "next/server";

import { proxy } from "@/proxy";
import { db } from "@/lib/db";
import { createWorkspaceUser } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("protected pages redirect to internal login while protected APIs retain 401", { skip: !enabled }, async () => {
  const page = await proxy(new NextRequest("http://fieldframe.test/workspace/cm123?next=https://attacker.invalid"));
  assert.equal(page.status, 307);
  assert.equal(page.headers.get("location"), "http://fieldframe.test/login?returnTo=%2Fworkspace%2Fcm123%3Fnext%3Dhttps%3A%2F%2Fattacker.invalid");
  const api = await proxy(new NextRequest("http://fieldframe.test/api/jobs/cm123"));
  assert.equal(api.status, 401);
  assert.equal((await api.json()).error.code, "AUTH_REQUIRED");
});

test("only a current opaque session passes the proxy; revoked session returns to login", { skip: !enabled }, async () => {
  const user = await createWorkspaceUser();
  const token = "test-opaque-session";
  try {
    const session = await db.authSession.create({ data: { userId: user.id, refreshTokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000) } });
    const authenticated = new NextRequest("http://fieldframe.test/workspace/cm123");
    authenticated.cookies.set("fieldframe_session", token);
    assert.equal((await proxy(authenticated)).status, 200);
    await db.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    const revoked = new NextRequest("http://fieldframe.test/workspace/cm123");
    revoked.cookies.set("fieldframe_session", token);
    const response = await proxy(revoked);
    assert.equal(response.status, 307);
    assert.match(response.headers.get("location") ?? "", /\/login\?returnTo=/);
  } finally { await db.user.delete({ where: { id: user.id } }).catch(() => undefined); }
});
