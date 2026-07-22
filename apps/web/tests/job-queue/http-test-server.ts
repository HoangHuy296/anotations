import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

export async function startJobHttpServer(port: number) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, PRISMA_QUERY_ENGINE_LIBRARY: resolve(process.cwd(), "../../lib/generated/prisma/libquery_engine-debian-openssl-3.0.x.so.node") },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/auth/me`)).status === 401) return { baseUrl, server }; } catch { /* server booting */ }
    await new Promise((done) => setTimeout(done, 250));
  }
  server.kill("SIGTERM");
  throw new Error("Next.js test server did not start.");
}

export async function stopJobHttpServer(server: ChildProcess | undefined) {
  if (server?.exitCode === null) await new Promise<void>((done) => { server.once("exit", () => done()); server.kill("SIGTERM"); });
}

export async function loginForJobHttp(baseUrl: string, email: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token, "login must issue an opaque session cookie");
  return `fieldframe_session=${token}`;
}
