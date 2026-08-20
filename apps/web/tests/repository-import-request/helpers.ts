import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

import { createQueueTransport, readSafeLocalQueueTestConfig } from "@annotationplatform/queue";

import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";

import {
  assertNoPreflightSecret,
  createOwnedPreflightGiteaConnection,
  preflightBusinessSnapshot,
  preflightHttpEnabled,
  preflightHttpSkipReason,
  registerAndLoginPreflightUser,
  removePreflightUser,
} from "../repository-preflight/helpers";

export { assertNoPreflightSecret as assertNoRepositoryImportSecret, preflightHttpSkipReason };

/**
 * Phase-015 runs only on the Phase-014 controlled Compose HTTP topology and a
 * separate passworded Redis namespace. It deliberately has no localhost or
 * unauthenticated fallback.
 */
export const repositoryImportHttpEnabled = preflightHttpEnabled
  && process.env.QUEUE_INTEGRATION_TESTS === "1"
  && process.env.REDIS_TEST_PREFIX === process.env.BULLMQ_PREFIX
  && process.env.REDIS_DB === process.env.REDIS_TEST_DB
  // These acceptance assertions deliberately observe QUEUED Jobs and exact
  // queue events. A worker consuming the isolated namespace would turn that
  // into a scheduler race rather than an acceptance-boundary test.
  && process.env.REPOSITORY_IMPORT_TEST_CONSUMERS_STOPPED === "1";

export const repositoryImportHttpSkipReason =
  "repository-import HTTP integration skipped: requires controlled Phase-014 HTTP fixtures, QUEUE_INTEGRATION_TESTS=1, an isolated Redis DB/prefix, and no worker consuming that isolated namespace";

const httpBaseUrl = process.env.REPOSITORY_PREFLIGHT_HTTP_BASE_URL ?? "";
const execFileAsync = promisify(execFile);

export type RepositoryImportRequestBody = {
  provider: "GITHUB" | "GITEA";
  credentialMode: "PUBLIC" | "EXISTING_SOURCE_CONNECTION" | "ONE_TIME_PAT";
  repository: {
    owner: string;
    name: string;
    repoUrl?: string;
    ref: string;
    rootPath?: string;
    expectedVisibility: "PUBLIC" | "PRIVATE";
  };
  sourceConnectionId?: string;
  serverUrl?: string;
  personalAccessToken?: string;
  saveAsSourceConnection?: boolean;
  connectionName?: string;
  datasetName: string;
  idempotencyKey: string;
};

export function uniqueRepositoryImportKey(prefix = "phase015") {
  return `${prefix}-${Date.now()}-${randomBytes(12).toString("hex")}`;
}

export function publicGithubRequest(overrides: Partial<RepositoryImportRequestBody> = {}): RepositoryImportRequestBody {
  const { repository: repositoryOverrides, ...requestOverrides } = overrides;
  const repository = {
    owner: "fixture",
    name: "public-images",
    repoUrl: "https://github.com/fixture/public-images",
    ref: "main",
    rootPath: "images",
    expectedVisibility: "PUBLIC" as const,
    ...repositoryOverrides,
  };
  if (repositoryOverrides?.repoUrl === undefined) {
    repository.repoUrl = `https://github.com/${repository.owner}/${repository.name}`;
  }
  return {
    provider: "GITHUB",
    credentialMode: "PUBLIC",
    repository,
    datasetName: `phase015-github-${randomBytes(5).toString("hex")}`,
    idempotencyKey: uniqueRepositoryImportKey(),
    ...requestOverrides,
  };
}

export function publicGiteaRequest(overrides: Partial<RepositoryImportRequestBody> = {}): RepositoryImportRequestBody {
  const { repository: repositoryOverrides, ...requestOverrides } = overrides;
  const mode = overrides.credentialMode ?? (overrides.sourceConnectionId ? "EXISTING_SOURCE_CONNECTION" : "PUBLIC");
  const repository = {
    owner: "annotation-admin",
    name: "ImageDataset",
    ref: "main",
    expectedVisibility: "PUBLIC" as const,
    ...repositoryOverrides,
  };
  return {
    provider: "GITEA",
    credentialMode: mode,
    ...(mode === "PUBLIC" ? { serverUrl: process.env.GITEA_PUBLIC_URL ?? "http://localhost:3100" } : {}),
    repository,
    datasetName: `phase015-gitea-${randomBytes(5).toString("hex")}`,
    idempotencyKey: uniqueRepositoryImportKey(),
    ...requestOverrides,
  };
}

export async function repositoryImportRequest(cookie: string | null, body: unknown) {
  return fetch(`${httpBaseUrl}/api/datasets/from-repository`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** Normal public signup/login only; this helper never manufactures a session. */
export async function registerAndLoginRepositoryImportUser() {
  return registerAndLoginPreflightUser();
}

/** An active owned connection is created through the Phase-013 normal-cookie API. */
export async function createOwnedRepositoryImportGiteaConnection(cookie: string, token: string) {
  return createOwnedPreflightGiteaConnection(cookie, token);
}

/**
 * Exact canonical IDs prove no hidden replacement row was written. Queue and
 * MinIO snapshots are restricted to the controlled Phase-015 namespace.
 */
export async function repositoryImportSnapshot() {
  const business = await preflightBusinessSnapshot();
  const { config, minio } = getDirectUploadProviders();
  const minioObjectKeys: string[] = [];
  const minioPrefix = process.env.REPOSITORY_IMPORT_MINIO_TEST_PREFIX ?? "phase015-test/";
  for await (const object of minio.listObjectsV2(config.MINIO_BUCKET, minioPrefix, true)) {
    if (object.name) minioObjectKeys.push(object.name);
  }
  const queue = safeQueueInspector();
  let queueCounts: Record<string, number>;
  try {
    queueCounts = await queue.getJobCounts("wait", "active", "delayed", "completed", "failed");
  } finally {
    await queue.close();
  }
  const queueConfig = readSafeLocalQueueTestConfig();
  const { stdout } = await execFileAsync(
    "docker",
    [
      "compose", "exec", "-T", "redis", "sh", "-lc",
      // The password remains inside the Compose container. This returns only
      // names from the explicitly isolated test namespace, never Redis values.
      `redis-cli --no-auth-warning -a \"$REDIS_PASSWORD\" -n ${queueConfig.REDIS_TEST_DB} --scan --pattern \"${queueConfig.REDIS_TEST_PREFIX}:*\"`,
    ],
    { cwd: new URL("../../../../", import.meta.url).pathname, maxBuffer: 512 * 1024 },
  );
  return {
    datasetIds: business.datasets.map((dataset) => dataset.id),
    jobIds: business.jobs.map((job) => job.id),
    jobEventIds: business.events.map((event) => event.id),
    sourceConnectionIds: business.connections.map((connection) => connection.id),
    queue: queueCounts,
    // Exact isolated key names catch queue mutations which may not change a
    // BullMQ count (for example, a transient metadata key). Values are never
    // read because they could contain transport data.
    redisKeys: stdout.split("\n").map((key) => key.trim()).filter(Boolean).sort(),
    minioObjectKeys: minioObjectKeys.sort(),
  };
}

export function assertNoRepositoryImportSideEffect(
  before: Awaited<ReturnType<typeof repositoryImportSnapshot>>,
  after: Awaited<ReturnType<typeof repositoryImportSnapshot>>,
) {
  assert.deepEqual(after, before, "rejected repository import must not mutate Dataset/Job/JobEvent, isolated Redis, or MinIO");
}

export async function getRepositoryImportJob(jobId: string) {
  return db.job.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      id: true,
      datasetId: true,
      createdById: true,
      sourceConnectionId: true,
      status: true,
      type: true,
      input: true,
      queueName: true,
      queueJobId: true,
      enqueuedAt: true,
      idempotencyKey: true,
    },
  });
}

/** Safe queue-event evidence only: never return raw event `data`. */
export async function repositoryImportQueueEvents(jobId: string) {
  return db.jobEvent.findMany({
    where: { jobId, message: "QUEUE_ENQUEUED" },
    select: { id: true, message: true, jobId: true },
    orderBy: { id: "asc" },
  });
}

export function safeQueueInspector() {
  const config = readSafeLocalQueueTestConfig();
  const queue = createQueueTransport({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    db: config.REDIS_TEST_DB,
    prefix: config.REDIS_TEST_PREFIX,
    failFast: true,
  });
  return {
    getJob: (jobId: string) => queue.getJob(jobId),
    getJobCounts: (...types: Array<"wait" | "active" | "delayed" | "completed" | "failed">) => queue.getJobCounts(...types),
    removeJob: async (jobId: string) => { await queue.remove(jobId).catch(() => undefined); },
    close: () => queue.close(),
  };
}

/** Delete Dataset first so Job foreign keys cannot block test-user cleanup. */
export async function cleanupRepositoryImportUser(userId: string) {
  await db.dataset.deleteMany({ where: { ownerId: userId } });
  await removePreflightUser(userId);
}
