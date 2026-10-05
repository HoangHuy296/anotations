import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasIntegrationDatabase } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && hasIntegrationDatabase;
const port = 34_000 + (randomBytes(2).readUInt16BE(0) % 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const marker = randomBytes(6).toString("hex");
const password = "production-auth-runtime-password";
let server: ChildProcess | undefined;
let serverExited = false;
let serverReportedReady = false;
let diagnostic = "";
let userId = "";
let email = "";

function safeDiagnostic() {
  return diagnostic
    .replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[redacted]")
    .slice(-2_000);
}

async function waitForReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (serverExited) throw new Error(`production auth server exited before readiness: ${safeDiagnostic()}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (serverReportedReady && (response.status === 401 || response.status === 200)) return;
    } catch {
      // The isolated production server has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`production auth server did not become ready: ${safeDiagnostic()}`);
}

before(async () => {
  if (!enabled) return;
  email = `production-auth-${marker}@test.invalid`;
  const user = await db.user.create({
    data: { email, passwordHash: await hashPassword(password), role: UserRole.LABELER },
    select: { id: true },
  });
  userId = user.id;

  server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: Buffer) => {
    const value = chunk.toString();
    if (/\bready\b/i.test(value)) serverReportedReady = true;
    diagnostic = `${diagnostic}${value}`.slice(-4_000);
  };
  server.stdout?.on("data", capture);
  server.stderr?.on("data", capture);
  server.once("exit", () => { serverExited = true; });
  await waitForReady();
});

after(async () => {
  if (server?.exitCode === null) {
    await new Promise<void>((resolve) => {
      server?.once("exit", resolve);
      server?.kill("SIGTERM");
    });
  }
  if (userId) await db.user.deleteMany({ where: { id: userId } });
});

test("production login creates a session before /api/auth/me resolves it", { skip: !enabled }, async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const sessionCount = await db.authSession.count({ where: { userId } });
  assert.equal(login.status, 200, `login failed; persistedAuthSessions=${sessionCount}; ${safeDiagnostic()}`);
  assert.equal(sessionCount, 1);

  const token = /^fieldframe_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token, "login response did not set the opaque session cookie");
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: `fieldframe_session=${token}` } });
  assert.equal(me.status, 200, `authenticated me request failed; ${safeDiagnostic()}`);
});
