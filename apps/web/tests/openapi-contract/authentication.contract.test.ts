/**
 * OpenAPI contract check for the Authentication tag (specs/api/openapi.yaml,
 * schemas/authentication.yaml). Runs against an already-running web service
 * over real HTTP -- set OPENAPI_CONTRACT_TESTS=1 (and, if the service is not
 * on the default port, OPENAPI_CONTRACT_BASE_URL) to enable.
 *
 * Scope is deliberately narrow: does the live response still match what
 * openapi.yaml documents (status, envelope, exact field set, cookie
 * attributes, the same-origin check on refresh/password/profile). Deeper
 * credential/session edge cases already live in tests/auth-ownership.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { db } from "@/lib/db";
import { normalizeEmail } from "@/lib/auth";

import { assertExactKeys, contractFetch, contractLogin, contractPassword, contractTestsEnabled as enabled, contractUnique, sessionCookieFrom } from "./helpers";

const skip = enabled ? false : "Set OPENAPI_CONTRACT_TESTS=1 against a running web service (see tests/openapi-contract/helpers.ts).";
const AUTHENTICATED_USER_KEYS = ["id", "email", "name", "role"] as const;
const cleanupEmails: string[] = [];

after(async () => {
  if (cleanupEmails.length) await db.user.deleteMany({ where: { email: { in: cleanupEmails.map(normalizeEmail) } } });
});

test("POST /api/auth/signup returns 201 with the documented AuthenticatedUser shape and no session cookie", { skip }, async () => {
  const email = `${contractUnique("contract-auth")}@test.invalid`;
  cleanupEmails.push(email);
  const response = await contractFetch("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password: contractPassword, role: "LABELER" }) });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("set-cookie"), null, "signup must not establish a session (AGENTS.md: sign in afterward through /login)");
  const body = await response.json() as { data: Record<string, unknown> };
  assertExactKeys(body.data, AUTHENTICATED_USER_KEYS, "signup response");
  assert.equal(body.data.email, email);
  assert.equal(body.data.role, "LABELER");
});

test("POST /api/auth/signup rejects role: ADMIN (not a self-service value)", { skip }, async () => {
  const email = `${contractUnique("contract-auth-admin")}@test.invalid`;
  const response = await contractFetch("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password: contractPassword, role: "ADMIN" }) });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "INVALID_REQUEST");
});

test("POST /api/auth/login: wrong password is 401 AUTH_REQUIRED; correct credentials return 200 with an httpOnly, SameSite=lax session cookie", { skip }, async () => {
  const email = `${contractUnique("contract-auth")}@test.invalid`;
  cleanupEmails.push(email);
  await contractFetch("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password: contractPassword, role: "MANAGER" }) });

  const wrong = await contractFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "the-wrong-password-value" }) });
  assert.equal(wrong.status, 401);
  const wrongBody = await wrong.json() as { error: { code: string } };
  assert.equal(wrongBody.error.code, "AUTH_REQUIRED");

  const response = await contractFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: contractPassword }) });
  assert.equal(response.status, 200);
  const { setCookie, cookie } = sessionCookieFrom(response);
  assert.ok(cookie, "login must set fieldframe_session");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=lax/i);
  const body = await response.json() as { data: Record<string, unknown> };
  assertExactKeys(body.data, AUTHENTICATED_USER_KEYS, "login response");
});

test("GET /api/auth/me requires authentication and echoes the same AuthenticatedUser shape once authenticated", { skip }, async () => {
  const unauth = await contractFetch("/api/auth/me");
  assert.equal(unauth.status, 401);
  const unauthBody = await unauth.json() as { error: { code: string } };
  assert.equal(unauthBody.error.code, "AUTH_REQUIRED");

  const email = `${contractUnique("contract-auth")}@test.invalid`;
  cleanupEmails.push(email);
  await contractFetch("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password: contractPassword, role: "MANAGER" }) });
  const cookie = await contractLogin(email);
  const response = await contractFetch("/api/auth/me", { cookie });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: Record<string, unknown> };
  assertExactKeys(body.data, AUTHENTICATED_USER_KEYS, "me response");
  assert.equal(body.data.email, email);
});

test("POST /api/auth/refresh and POST /api/auth/password reject a cross-origin Origin header with 401, independent of the session cookie", { skip }, async () => {
  const email = `${contractUnique("contract-auth")}@test.invalid`;
  cleanupEmails.push(email);
  await contractFetch("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password: contractPassword, role: "MANAGER" }) });
  const cookie = await contractLogin(email);

  const crossOriginRefresh = await contractFetch("/api/auth/refresh", { method: "POST", cookie, headers: { origin: "https://not-this-app.example" } });
  assert.equal(crossOriginRefresh.status, 401);

  const crossOriginPassword = await contractFetch("/api/auth/password", { method: "POST", cookie, headers: { origin: "https://not-this-app.example" }, body: JSON.stringify({ currentPassword: contractPassword, newPassword: "a-different-long-password" }) });
  assert.equal(crossOriginPassword.status, 401);

  const sameOriginRefresh = await contractFetch("/api/auth/refresh", { method: "POST", cookie });
  assert.equal(sameOriginRefresh.status, 200);
  const { cookie: rotated } = sessionCookieFrom(sameOriginRefresh);
  assert.ok(rotated, "refresh must issue a replacement session cookie");
});

test("PATCH /api/auth/profile updates name and never returns email/role edits (not accepted fields)", { skip }, async () => {
  const email = `${contractUnique("contract-auth")}@test.invalid`;
  cleanupEmails.push(email);
  await contractFetch("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password: contractPassword, role: "LABELER" }) });
  const cookie = await contractLogin(email);
  const newName = contractUnique("renamed");
  const response = await contractFetch("/api/auth/profile", { method: "PATCH", cookie, body: JSON.stringify({ name: newName }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: Record<string, unknown> };
  assertExactKeys(body.data, AUTHENTICATED_USER_KEYS, "profile response");
  assert.equal(body.data.name, newName);
  assert.equal(body.data.email, email);
  assert.equal(body.data.role, "LABELER");
});

test("POST /api/auth/logout returns 204 and clears the session cookie; the cleared cookie no longer authenticates", { skip }, async () => {
  const email = `${contractUnique("contract-auth")}@test.invalid`;
  cleanupEmails.push(email);
  await contractFetch("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password: contractPassword, role: "MANAGER" }) });
  const cookie = await contractLogin(email);

  const response = await contractFetch("/api/auth/logout", { method: "POST", cookie });
  assert.equal(response.status, 204);
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /fieldframe_session=;/);
  assert.match(setCookie, /HttpOnly/i);

  const afterLogout = await contractFetch("/api/auth/me", { cookie });
  assert.equal(afterLogout.status, 401);
});
