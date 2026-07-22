import assert from "node:assert/strict";
import test from "node:test";

import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { db } from "@/lib/db";
import { workspaceUnique } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const forbidden = ["passwordHash", "refreshTokenHash", "jwt", "accessToken", "DATABASE_URL", "MINIO_SECRET_KEY", "REDIS_PASSWORD"];

test("auth responses expose neither credentials nor opaque session values in JSON", { skip: !enabled }, async () => {
  const email = `${workspaceUnique("workspace-redaction")}@test.invalid`;
  const password = "workspace-redaction-password";
  try {
    const signupResponse = await signup(new Request("http://fieldframe.test/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, role: "LABELER" }) }));
    const signupBody = await signupResponse.text();
    for (const value of forbidden) assert.equal(signupBody.includes(value), false, value);
    assert.equal(signupBody.includes(password), false);
    const loginResponse = await login(new Request("http://fieldframe.test/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }));
    const loginBody = await loginResponse.text();
    for (const value of forbidden) assert.equal(loginBody.includes(value), false, value);
    assert.equal(loginBody.includes(password), false);
  } finally { await db.user.deleteMany({ where: { email } }); }
});
