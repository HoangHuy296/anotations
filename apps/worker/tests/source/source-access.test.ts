import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { resolveSourceAccessForJob, resolveWorkerReachableGiteaBaseUrl } from "../../src/source/source-access.js";

const enabled = Boolean(process.env.DATABASE_URL && process.env.SOURCE_CONNECTION_ENCRYPTION_KEY);
const skip = "source worker integration skipped: controlled PostgreSQL or source encryption configuration is unavailable";

test("worker maps only the exact configured public Compose Gitea root to its server-controlled internal endpoint", () => {
  const environment = {
    ANNOTATIONPLATFORM_RUNTIME: "compose",
    GITEA_PUBLIC_URL: "http://localhost:3100/",
    GITEA_INTERNAL_URL: "http://gitea:3000",
  };
  assert.equal(resolveWorkerReachableGiteaBaseUrl("http://localhost:3100", environment), "http://gitea:3000");
  assert.equal(resolveWorkerReachableGiteaBaseUrl("http://untrusted.invalid:3100", environment), "http://untrusted.invalid:3100");
  assert.equal(resolveWorkerReachableGiteaBaseUrl("http://localhost:3100", { ...environment, ANNOTATIONPLATFORM_RUNTIME: "host" }), "http://localhost:3100");
});

function encryptForWorker(token: string) {
  const encoded = process.env.SOURCE_CONNECTION_ENCRYPTION_KEY;
  if (!encoded) throw new Error("missing test encryption configuration");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("invalid test encryption configuration");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

async function fixture() {
  const db = createWorkerDatabase(getWorkerConfig());
  const suffix = `${Date.now()}-${randomBytes(5).toString("hex")}`;
  const owner = await db.user.create({ data: { email: `source-worker-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `source-worker-${suffix}` }, select: { id: true } });
  const connection = await db.sourceConnection.create({
    data: {
      userId: owner.id,
      provider: "GITEA",
      authType: "TOKEN",
      baseUrl: "http://gitea:3000",
      tokenEncrypted: encryptForWorker("test-token-not-logged"),
      status: "ACTIVE",
    },
    select: { id: true },
  });
  const createJob = (overrides: { sourceConnectionId?: string; root?: string; createdById?: string } = {}) => db.job.create({
    data: {
      datasetId: dataset.id,
      createdById: overrides.createdById ?? owner.id,
      type: "IMPORT_DATASET",
      status: "QUEUED",
      sourceConnectionId: overrides.sourceConnectionId ?? connection.id,
      input: { source: { repository: { provider: "GITEA", owner: "owner", repo: "repo", ref: "main", rootPath: overrides.root ?? "images", visibility: "PRIVATE" }, manifest: { itemCount: 1, declaredBytes: 1 }, sourceConnectionId: overrides.sourceConnectionId ?? connection.id } },
    },
    select: { id: true },
  });
  const cleanup = async () => {
    await db.dataset.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  };
  return { db, owner, dataset, connection, createJob, cleanup };
}

test("worker reloads PostgreSQL state, accepts rotation, and refuses a revoked connection before provider access", { skip: enabled ? false : skip }, async () => {
  const value = await fixture();
  try {
    const job = await value.createJob();
    const initial = await resolveSourceAccessForJob(value.db, job.id);
    assert.equal(initial.kind, "ready");
    if (initial.kind === "ready") {
      assert.equal(initial.sourceConnectionId, value.connection.id);
      assert.equal(initial.rootPath, "images");
      assert.ok(initial.token.length > 0);
    }

    await value.db.sourceConnection.update({ where: { id: value.connection.id }, data: { tokenEncrypted: encryptForWorker("rotated-token-not-logged") } });
    const rotated = await resolveSourceAccessForJob(value.db, job.id);
    assert.equal(rotated.kind, "ready");
    if (rotated.kind === "ready") assert.ok(rotated.token.length > 0);

    await value.db.sourceConnection.update({ where: { id: value.connection.id }, data: { status: "REVOKED", revokedAt: new Date(), tokenEncrypted: null } });
    assert.deepEqual(await resolveSourceAccessForJob(value.db, job.id), { kind: "refused", errorCode: "SOURCE_CONNECTION_NOT_FOUND" });
  } finally {
    await value.cleanup();
  }
});

test("worker marks an expired token and safely rejects invalid root and foreign ownership", { skip: enabled ? false : skip }, async () => {
  const value = await fixture();
  try {
    const expiredJob = await value.createJob();
    await value.db.sourceConnection.update({ where: { id: value.connection.id }, data: { tokenExpiresAt: new Date(Date.now() - 1_000) } });
    assert.deepEqual(await resolveSourceAccessForJob(value.db, expiredJob.id), { kind: "refused", errorCode: "SOURCE_TOKEN_EXPIRED" });
    assert.equal((await value.db.sourceConnection.findUniqueOrThrow({ where: { id: value.connection.id }, select: { status: true } })).status, "EXPIRED");

    await value.db.sourceConnection.update({ where: { id: value.connection.id }, data: { status: "ACTIVE", tokenExpiresAt: null, tokenEncrypted: encryptForWorker("fresh-token-not-logged") } });
    const unsafeRootJob = await value.createJob({ root: "../outside" });
    assert.deepEqual(await resolveSourceAccessForJob(value.db, unsafeRootJob.id), { kind: "refused", errorCode: "SOURCE_ROOT_PATH_UNSAFE" });

    const foreign = await value.db.user.create({ data: { email: `source-worker-foreign-${randomBytes(5).toString("hex")}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    try {
      const foreignJob = await value.createJob({ createdById: foreign.id });
      assert.deepEqual(await resolveSourceAccessForJob(value.db, foreignJob.id), { kind: "refused", errorCode: "SOURCE_CONNECTION_NOT_FOUND" });
    } finally {
      await value.db.job.deleteMany({ where: { createdById: foreign.id } });
      await value.db.user.delete({ where: { id: foreign.id } });
    }
  } finally {
    await value.cleanup();
  }
});

test("worker safely projects an over-limit durable source manifest", { skip: enabled ? false : skip }, async () => {
  const value = await fixture();
  try {
    const job = await value.db.job.create({ data: { datasetId: value.dataset.id, createdById: value.owner.id, type: "IMPORT_DATASET", status: "QUEUED", sourceConnectionId: value.connection.id, input: { source: { repository: { provider: "GITEA", owner: "owner", repo: "repo", ref: "main", rootPath: "images", visibility: "PRIVATE" }, manifest: { itemCount: 2_001, declaredBytes: 1 }, sourceConnectionId: value.connection.id } } }, select: { id: true } });
    assert.deepEqual(await resolveSourceAccessForJob(value.db, job.id), { kind: "refused", errorCode: "SOURCE_IMPORT_LIMIT_EXCEEDED" });
  } finally { await value.cleanup(); }
});
