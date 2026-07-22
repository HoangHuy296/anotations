import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { after, before } from "node:test";
import { UserRole } from "@internal/db";

import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { getActorFromSessionToken, normalizeEmail } from "@/lib/auth";
import { db } from "@/lib/db";
import { workspaceUnique } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const httpEnabled = enabled && process.env.AUTH_PAGE_HTTP_INTEGRATION_TESTS === "1";
const password = "workspace-auth-password";
const port = 3_118;
const baseUrl = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/auth/me`)).status === 401) return; } catch { /* server starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Authentication page test server did not start.");
}

function sessionCookie(response: Response) {
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token, "login must set an opaque HTTP-only cookie");
  return { token, header: `fieldframe_session=${token}` };
}

before(async () => {
  if (!httpEnabled) return;
  server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], { cwd: process.cwd(), env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "ignore" });
  await waitForServer();
});

after(async () => {
  if (server && server.exitCode === null) await new Promise<void>((resolve) => { server?.once("exit", resolve); server?.kill("SIGTERM"); });
});

function tokenFrom(response: Response) {
  return /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? null;
}

test("registration persists an explicitly selected permitted role with an opaque cookie session", { skip: !enabled }, async () => {
  const emails: string[] = [];
  try {
    for (const role of [UserRole.MANAGER, UserRole.LABELER, UserRole.REVIEWER]) {
      const email = `${workspaceUnique(`workspace-auth-${role.toLowerCase()}`)}@test.invalid`;
      emails.push(email);
      const created = await signup(new Request("http://fieldframe.test/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, role }) }));
      assert.equal(created.status, 201);
      const signupPayload = await created.json() as { data: Record<string, unknown> };
      assert.equal(signupPayload.data.email, email);
      assert.equal(signupPayload.data.role, role);
      assert.equal("token" in signupPayload.data, false);
      assert.equal("passwordHash" in signupPayload.data, false);
      const stored = await db.user.findUnique({ where: { email }, select: { passwordHash: true, role: true, sessions: { select: { id: true } } } });
      assert.ok(stored?.passwordHash);
      assert.notEqual(stored.passwordHash, password);
      assert.equal(stored.role, role);
      assert.equal(stored.sessions.length, 1);
      const loginResponse = await login(new Request("http://fieldframe.test/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }));
      assert.equal(loginResponse.status, 200);
      const token = tokenFrom(loginResponse);
      assert.ok(token);
      assert.match(loginResponse.headers.get("set-cookie") ?? "", /HttpOnly/i);
      assert.equal((await getActorFromSessionToken(token))?.email, email);
      const duplicate = await signup(new Request("http://fieldframe.test/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, role }) }));
      assert.equal(duplicate.status, 409);
    }
    const invalid = await login(new Request("http://fieldframe.test/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: emails[0], password: "short" }) }));
    assert.equal(invalid.status, 400);
  } finally { await db.user.deleteMany({ where: { email: { in: emails.map(normalizeEmail) } } }); }
});

test("registration rejects missing, admin, or malformed roles without creating a user or session", { skip: !enabled }, async () => {
  const cases: Array<{ suffix: string; role?: string }> = [{ suffix: "missing" }, { suffix: "admin", role: "ADMIN" }, { suffix: "invalid", role: "SYSTEM" }];
  for (const entry of cases) {
    const email = `${workspaceUnique(`workspace-role-${entry.suffix}`)}@test.invalid`;
    try {
      const response = await signup(new Request("http://fieldframe.test/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, ...(entry.role ? { role: entry.role } : {}) }) }));
      assert.equal(response.status, 400);
      const payload = await response.json() as { error: { code: string } };
      assert.equal(payload.error.code, "INVALID_REQUEST");
      assert.equal(await db.user.count({ where: { email } }), 0);
      assert.equal(await db.authSession.count({ where: { user: { email } } }), 0);
    } finally { await db.user.deleteMany({ where: { email } }); }
  }
});

test("a seeded-style user without a password hash cannot use normal login", { skip: !enabled }, async () => {
  const email = `${workspaceUnique("workspace-passwordless")}@test.invalid`;
  try {
    await db.user.create({ data: { email, role: UserRole.ADMIN, passwordHash: null } });
    const response = await login(new Request("http://fieldframe.test/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }));
    assert.equal(response.status, 401);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, "AUTH_REQUIRED");
    assert.equal(await db.authSession.count({ where: { user: { email } } }), 0);
  } finally { await db.user.deleteMany({ where: { email } }); }
});

test("actual auth HTTP flow signs out and rejects expired or revoked opaque sessions", { skip: !httpEnabled }, async () => {
  const email = `${workspaceUnique("workspace-page-flow")}@test.invalid`;
  try {
    const unauthenticated = await fetch(`${baseUrl}/dashboard`, { redirect: "manual" });
    assert.equal(unauthenticated.status, 307);
    assert.match(unauthenticated.headers.get("location") ?? "", /\/login\?returnTo=%2Fdashboard/);
    const registered = await fetch(`${baseUrl}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, role: UserRole.LABELER }) });
    assert.equal(registered.status, 201);
    const initial = sessionCookie(registered);
    assert.match(registered.headers.get("set-cookie") ?? "", /HttpOnly/i);
    const protectedResponse = await fetch(`${baseUrl}/dashboard`, { headers: { Cookie: initial.header }, redirect: "manual" });
    assert.equal(protectedResponse.status, 200);
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: initial.header } });
    assert.equal(me.status, 200);
    const profile = await me.json() as { data: Record<string, unknown> };
    assert.equal(profile.data.email, email);
    assert.equal("passwordHash" in profile.data, false);
    assert.equal("token" in profile.data, false);
    const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { Cookie: initial.header } });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get("set-cookie") ?? "", /fieldframe_session=;/);
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: initial.header } })).status, 401);
    const loggedOut = await fetch(`${baseUrl}/dashboard`, { headers: { Cookie: initial.header }, redirect: "manual" });
    assert.equal(loggedOut.status, 307);
    const loggedIn = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    assert.equal(loggedIn.status, 200);
    const expired = sessionCookie(loggedIn);
    await db.authSession.updateMany({ where: { refreshTokenHash: createHash("sha256").update(expired.token).digest("hex") }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    assert.equal((await fetch(`${baseUrl}/dashboard`, { headers: { Cookie: expired.header }, redirect: "manual" })).status, 307);
    const relogin = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const revoked = sessionCookie(relogin);
    await db.authSession.updateMany({ where: { refreshTokenHash: createHash("sha256").update(revoked.token).digest("hex") }, data: { revokedAt: new Date() } });
    assert.equal((await fetch(`${baseUrl}/dashboard`, { headers: { Cookie: revoked.header }, redirect: "manual" })).status, 307);
  } finally { await db.user.deleteMany({ where: { email: normalizeEmail(email) } }); }
});
