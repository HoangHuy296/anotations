import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { fixtureBytes } from "../direct-upload/helpers";
import { configureLocalImportHostMinio } from "./helpers";

export type UploadCapability = {
  itemId: string;
  uploadUrl: string;
  method: "POST";
  formFields: Record<string, string>;
  fileId: string;
  expiresInSeconds: number;
};

export type LocalImportHttpFixture = {
  baseUrl: string;
  password: string;
  users: Record<"admin" | "manager" | "labeler" | "reviewer" | "outsider", { id: string; email: string }>;
  cookieFor: (key: "admin" | "manager" | "labeler" | "reviewer" | "outsider") => Promise<string>;
  start: (input?: { name?: string; items?: Array<{ logicalPath: string; contentType?: string; body?: string }> }) => Promise<{ id: string; datasetId: string; jobId: string; items: Array<{ id: string }> }>;
  capabilities: (preparedImportId: string, itemIds: string[], cookie?: string) => Promise<Response>;
  complete: (preparedImportId: string, itemId: string, fileId: string, cookie?: string) => Promise<Response>;
  postUpload: (capability: UploadCapability, contentType: "image/png" | "video/mp4" | "text/plain" | "audio/wav", filename: string) => Promise<Response>;
  cleanup: () => Promise<void>;
};

function sessionCookie(response: Response) {
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token, "normal login must issue an opaque cookie session");
  return `fieldframe_session=${token}`;
}

async function waitForServer(baseUrl: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/auth/me`)).status === 401) return;
    } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Phase 010 HTTP test server did not start.");
}

export async function createLocalImportHttpFixture(port: number): Promise<LocalImportHttpFixture> {
  configureLocalImportHostMinio();
  const baseUrl = `http://127.0.0.1:${port}`;
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const password = "phase010-http-password";
  const passwordHash = await hashPassword(password);
  const roles = [
    ["admin", UserRole.ADMIN], ["manager", UserRole.MANAGER], ["labeler", UserRole.LABELER],
    ["reviewer", UserRole.REVIEWER], ["outsider", UserRole.MANAGER],
  ] as const;
  const records = await Promise.all(roles.map(async ([key, role]) => [key, await db.user.create({
    data: { email: `phase010-${key}-${suffix}@test.local`, passwordHash, role }, select: { id: true, email: true },
  })] as const));
  const users = Object.fromEntries(records) as LocalImportHttpFixture["users"];
  let server: ChildProcess | undefined;
  const cookies = new Map<string, string>();

  try {
    server = spawn("node_modules/.bin/next", ["start", "--port", String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MINIO_ENDPOINT: "http://localhost:9000",
        MINIO_PUBLIC_ENDPOINT: "http://localhost:9000",
        PRISMA_QUERY_ENGINE_LIBRARY: resolve(process.cwd(), "../../lib/generated/prisma/libquery_engine-debian-openssl-3.0.x.so.node"),
      },
      stdio: "ignore",
    });
    await waitForServer(baseUrl);
  } catch (error) {
    server?.kill("SIGTERM");
    await db.user.deleteMany({ where: { id: { in: Object.values(users).map((user) => user.id) } } });
    throw error;
  }

  async function cookieFor(key: keyof LocalImportHttpFixture["users"]) {
    const existing = cookies.get(key);
    if (existing) return existing;
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: users[key].email, password }),
    });
    assert.equal(response.status, 200, `login for ${key} must succeed`);
    const cookie = sessionCookie(response);
    cookies.set(key, cookie);
    return cookie;
  }

  const managerCookie = () => cookieFor("manager");
  return {
    baseUrl,
    password,
    users,
    cookieFor,
    async start(input = {}) {
      const response = await fetch(`${baseUrl}/api/imports/local-folder`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: await managerCookie() },
        body: JSON.stringify({
          name: input.name ?? `Import ${suffix}`,
          idempotencyKey: randomBytes(20).toString("hex"),
          items: (input.items ?? [{ logicalPath: "folder/readme.txt", contentType: "text/plain" }]).map((item) => {
            const contentType = item.contentType ?? "text/plain";
            const bytes = fixtureBytes(contentType);
            return {
              logicalPath: item.logicalPath,
              contentType,
              sizeBytes: bytes.length,
              fingerprint: createHash("sha256").update(bytes).digest("hex"),
            };
          }),
        }),
      });
      assert.ok([201, 202].includes(response.status), "manager import start must be accepted");
      return (await response.json() as { data: { preparation: { id: string; datasetId: string; jobId: string; items: Array<{ id: string }> } } }).data.preparation;
    },
    async capabilities(preparedImportId, itemIds, cookie) {
      return fetch(`${baseUrl}/api/imports/${preparedImportId}/upload-capabilities`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie ?? await managerCookie() }, body: JSON.stringify({ itemIds }),
      });
    },
    async complete(preparedImportId, itemId, fileId, cookie) {
      return fetch(`${baseUrl}/api/imports/${preparedImportId}/items/${itemId}/complete`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie ?? await managerCookie() }, body: JSON.stringify({ fileId }),
      });
    },
    async postUpload(capability, contentType, filename) {
      const form = new FormData();
      for (const [key, value] of Object.entries(capability.formFields)) form.append(key, value);
      form.append("file", new Blob([new Uint8Array(fixtureBytes(contentType))], { type: contentType }), filename);
      return fetch(capability.uploadUrl, { method: "POST", body: form });
    },
    async cleanup() {
      if (server?.exitCode === null) await new Promise<void>((resolve) => { server!.once("exit", resolve); server!.kill("SIGTERM"); });
      await db.dataset.deleteMany({ where: { ownerId: { in: Object.values(users).map((user) => user.id) } } });
      await db.user.deleteMany({ where: { id: { in: Object.values(users).map((user) => user.id) } } });
    },
  };
}

export async function addDatasetMember(datasetId: string, userId: string, role: DatasetMemberRole) {
  return db.datasetMember.create({ data: { datasetId, userId, role } });
}
