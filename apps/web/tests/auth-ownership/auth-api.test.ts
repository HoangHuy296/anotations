import assert from "node:assert/strict";
import test from "node:test";

import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { getActorFromSessionToken, normalizeEmail } from "@/lib/auth";
import { db } from "@/lib/db";
import { credentialsSchema, registrationSchema } from "@/lib/validation/auth";
import { hasIntegrationDatabase } from "./helpers";

test("signup/login input accepts valid credentials and rejects malformed bodies", () => {
  assert.equal(credentialsSchema.safeParse({ email: "user@example.test", password: "long-enough-password" }).success, true);
  assert.equal(credentialsSchema.safeParse({ email: "not-an-email", password: "short" }).success, false);
  assert.equal(credentialsSchema.safeParse({ email: "user@example.test", password: "long-enough-password", ownerId: "browser-controlled" }).success, false);
  assert.equal(registrationSchema.safeParse({ email: "user@example.test", password: "long-enough-password", role: "MANAGER" }).success, true);
  assert.equal(registrationSchema.safeParse({ email: "user@example.test", password: "long-enough-password" }).success, false);
  assert.equal(registrationSchema.safeParse({ email: "user@example.test", password: "long-enough-password", role: "ADMIN" }).success, false);
});

test("signup and login return safe responses and establish resolvable opaque sessions", { skip: !hasIntegrationDatabase }, async () => {
  const email = `auth-${Date.now()}@phase004.test`;
  const password = "long-enough-password";
  try {
    const signupResponse = await signup(new Request("http://fieldframe.test/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password, role: "MANAGER" }) }));
    assert.equal(signupResponse.status, 201);
    const signupBody = await signupResponse.json() as { data: Record<string, unknown> };
    assert.equal(signupBody.data.email, email);
    assert.equal(signupBody.data.role, "MANAGER");
    assert.equal("passwordHash" in signupBody.data, false);
    const loginResponse = await login(new Request("http://fieldframe.test/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }));
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get("set-cookie") ?? "";
    const token = /^fieldframe_session=([^;]+)/.exec(cookie)?.[1];
    assert.ok(token);
    assert.equal((await getActorFromSessionToken(token!))?.email, email);
    const badLogin = await login(new Request("http://fieldframe.test/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "wrong-password" }) }));
    assert.equal(badLogin.status, 401);
  } finally {
    await db.user.deleteMany({ where: { email: normalizeEmail(email) } });
  }
});
