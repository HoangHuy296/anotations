import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

import { createQueueTransport } from "@fieldframe/queue";

import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";

/** Test registration remains server-only through the existing Node preload. */
function isUsableHttpEndpoint(raw: string | undefined, allowedHosts: readonly string[]) {
  if (!raw || raw.includes("<") || raw.includes(">")) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && Boolean(url.port) && allowedHosts.includes(url.hostname);
  } catch {
    return false;
  }
}

const isolatedQueue = Boolean(process.env.REDIS_TEST_PREFIX)
  && process.env.BULLMQ_PREFIX !== "annotation-platform"
  && process.env.REDIS_DB === process.env.REDIS_TEST_DB;

/** Never let an enabled but placeholder-filled .env turn a no-op into evidence. */
export const preflightHttpEnabled = process.env.REPOSITORY_PREFLIGHT_INTEGRATION_TESTS === "1"
  && isUsableHttpEndpoint(process.env.REPOSITORY_PREFLIGHT_HTTP_BASE_URL, ["127.0.0.1", "localhost"])
  // The host test runner calls web through loopback; Compose web reaches this
  // controlled service through its private network name. No public provider is
  // accepted as an integration-test fixture.
  && isUsableHttpEndpoint(process.env.GITHUB_API_BASE_URL, ["127.0.0.1", "localhost", "github-fixture"])
  && isolatedQueue;

export const preflightHttpSkipReason = "repository-preflight HTTP integration skipped: require a usable loopback GitHub fixture endpoint plus isolated REDIS_DB/REDIS_TEST_DB and non-default REDIS_TEST_PREFIX/BULLMQ_PREFIX";

const httpBaseUrl = process.env.REPOSITORY_PREFLIGHT_HTTP_BASE_URL ?? "";
const testPassword = randomBytes(24).toString("base64url");
const execFileAsync = promisify(execFile);

function githubFixtureBaseUrl() {
  const raw = process.env.GITHUB_API_BASE_URL ?? "";
  const url = new URL(raw);
  if (!isUsableHttpEndpoint(raw, ["127.0.0.1", "localhost", "github-fixture"])) {
    throw new Error("controlled GitHub fixture endpoint is not configured");
  }
  return url.origin;
}

/** Fixture-only controls. They are never routed through Fieldframe. */
export async function resetGithubFixtureCounter() {
  const response = await fetch(`${githubFixtureBaseUrl()}/__test/reset`, { method: "POST" });
  assert.equal(response.status, 204, "GitHub fixture counter reset failed");
}

export async function githubFixtureRequestCount() {
  return (await githubFixtureCounters()).requests;
}

export async function githubFixturePathCount(path: string) {
  assert.ok(path.startsWith("/"));
  return (await githubFixtureCounters()).paths[path] ?? 0;
}

async function githubFixtureCounters() {
  const response = await fetch(`${githubFixtureBaseUrl()}/__test/counter`, { cache: "no-store" });
  assert.equal(response.status, 200, "GitHub fixture counter read failed");
  const body = await response.json() as { requests?: unknown; paths?: unknown };
  assert.equal(typeof body.requests, "number");
  assert.ok(body.paths && typeof body.paths === "object" && !Array.isArray(body.paths));
  const paths = Object.fromEntries(Object.entries(body.paths as Record<string, unknown>).map(([path, count]) => {
    assert.equal(typeof count, "number");
    return [path, count as number];
  }));
  return { requests: body.requests as number, paths };
}

/**
 * Gitea has no test counter API. In the explicit Compose-only assertion mode,
 * use its access log as the equivalent provider-call evidence. The helper
 * returns only a count and never surfaces log text (which could contain a
 * repository path); health checks are excluded by matching only `/api/v1/`.
 */
export async function giteaProviderAccessLogCountSince(since: Date) {
  if (process.env.GITEA_ACCESS_LOG_ASSERTIONS !== "1") return null;
  const { stdout } = await execFileAsync(
    "docker",
    ["compose", "logs", "--no-color", "--since", since.toISOString(), "gitea"],
    { cwd: new URL("../../../../", import.meta.url).pathname, maxBuffer: 512 * 1024 },
  );
  return stdout.split("\n").filter((line) => line.includes("/api/v1/")).length;
}

function sessionCookie(response: Response) {
  const match = /^fieldframe_session=([^;]+)/i.exec(response.headers.get("set-cookie") ?? "");
  assert.ok(match?.[1], "normal login must issue an opaque session cookie");
  return `fieldframe_session=${match[1]}`;
}

/** Uses only public signup/login endpoints; no auth bypass or seeded cookie. */
export async function registerAndLoginPreflightUser() {
  const email = `preflight-${Date.now()}-${randomBytes(6).toString("hex")}@test.invalid`;
  const signup = await fetch(`${httpBaseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: testPassword, name: "Preflight test", role: "MANAGER" }),
  });
  assert.equal(signup.status, 201, "normal signup must create a password-enabled test user");
  const profile = await signup.json() as { data?: { id?: string } };
  assert.ok(profile.data?.id);
  const login = await fetch(`${httpBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: testPassword }),
  });
  assert.equal(login.status, 200, "normal login must accept the registered user");
  return { userId: profile.data.id, cookie: sessionCookie(login) };
}

export async function preflightRequest(cookie: string | null, body: unknown) {
  return fetch(`${httpBaseUrl}/api/source-repositories/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** Creates a connection only through the approved normal-cookie API. This is
 * fixture setup; callers snapshot durable state only after it succeeds. */
export async function createOwnedPreflightGiteaConnection(cookie: string, token: string) {
  const response = await fetch(`${httpBaseUrl}/api/source-connections`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    // `gitea` is an allowlisted Compose-only fixture host. It is never taken
    // from a browser test parameter or returned in a preflight response.
    body: JSON.stringify({ provider: "GITEA", name: "Phase 014 fixture", baseUrl: "http://gitea:3000", token }),
  });
  const body = await response.json() as { data?: { connection?: { id?: string } }; error?: { code?: string } };
  assert.equal(response.status, 201, `controlled source connection setup failed with ${body.error?.code ?? "unknown"}`);
  assert.ok(body.data?.connection?.id);
  assertNoPreflightSecret(body, [token]);
  return body.data.connection.id;
}

export async function sourceImportRequest(path: "/api/source-import-preflight" | "/api/source-import-jobs" | "/api/gitea/import", cookie: string | null, body: unknown) {
  return fetch(`${httpBaseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

export async function removePreflightUser(id: string) {
  await db.user.delete({ where: { id } }).catch(() => undefined);
}

export async function preflightBusinessSnapshot() {
  const [datasets, jobs, events, connections, repositories, assets] = await Promise.all([
    db.dataset.findMany({ select: { id: true, ownerId: true, sourceMode: true, externalRepositoryId: true, sourceConnectionId: true, archivedAt: true, deletedAt: true }, orderBy: { id: "asc" } }),
    db.job.findMany({ select: { id: true, datasetId: true, createdById: true, type: true, status: true, stage: true, queueName: true, queueJobId: true, enqueuedAt: true, sourceConnectionId: true, externalRepositoryId: true, retryOfJobId: true }, orderBy: { id: "asc" } }),
    db.jobEvent.findMany({ select: { id: true, jobId: true, level: true, stage: true, createdAt: true }, orderBy: { id: "asc" } }),
    db.sourceConnection.findMany({ select: { id: true, userId: true, provider: true, status: true, tokenExpiresAt: true, revokedAt: true, tokenEncrypted: true, refreshTokenEncrypted: true }, orderBy: { id: "asc" } }),
    db.externalRepository.findMany({ select: { id: true, provider: true, visibility: true, baseUrl: true, fullName: true, defaultBranch: true, createdById: true }, orderBy: { id: "asc" } }),
    db.asset.findMany({ select: { id: true, datasetId: true, modality: true, filename: true, storageProvider: true, storageBucket: true, storageKey: true, sourceFingerprint: true, externalRepositoryId: true, status: true }, orderBy: { id: "asc" } }),
  ]);
  return {
    datasets,
    jobs,
    events,
    // Preserve only credential presence—not ciphertext—in test diagnostics.
    connections: connections.map(({ tokenEncrypted, refreshTokenEncrypted, ...connection }) => ({
      ...connection,
      hasToken: Boolean(tokenEncrypted),
      hasRefreshToken: Boolean(refreshTokenEncrypted),
    })),
    repositories,
    assets,
  };
}

export async function preflightTransportSnapshot() {
  const { config, minio } = getDirectUploadProviders();
  const prefix = "phase014-test/";
  const objects: string[] = [];
  for await (const object of minio.listObjectsV2(config.MINIO_BUCKET, prefix, true)) if (object.name) objects.push(object.name);
  const queue = createQueueTransport({
    host: process.env.REDIS_HOST ?? "redis",
    port: Number(process.env.REDIS_PORT ?? "6379"),
    password: process.env.REDIS_PASSWORD ?? "",
    db: Number(process.env.REDIS_DB ?? "15"),
    prefix: process.env.BULLMQ_PREFIX ?? "fieldframe-phase014-test",
    failFast: true,
  });
  try {
    // `apps/web` must not import ioredis/BullMQ directly. The controlled
    // Compose Redis container already owns its password in environment; this
    // test-only CLI query snapshots only our isolated namespace's key names.
    const prefix = process.env.BULLMQ_PREFIX ?? "fieldframe-phase014-test";
    assert.match(prefix, /^[A-Za-z0-9:_-]{8,120}$/);
    const redisDb = String(Number(process.env.REDIS_DB ?? "15"));
    const { stdout } = await execFileAsync(
      "docker",
      [
        "compose", "exec", "-T", "redis", "sh", "-lc",
        `redis-cli --no-auth-warning -a "$REDIS_PASSWORD" -n ${redisDb} --scan --pattern "${prefix}:*"`,
      ],
      { cwd: new URL("../../../../", import.meta.url).pathname, maxBuffer: 512 * 1024 },
    );
    return {
      objects: objects.sort(),
      queue: await queue.getJobCounts("wait", "active", "delayed", "completed", "failed"),
      redisKeys: stdout.split("\n").map((key) => key.trim()).filter(Boolean).sort(),
    };
  } finally {
    await queue.close();
  }
}

export function assertNoPreflightWrite<T>(before: T, after: T) {
  assert.deepEqual(after, before, "preflight must not write durable, queue, or storage state");
}

export function assertNoPreflightSecret(value: unknown, sentinels: readonly string[] = []) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "tokenEncrypted", "refreshTokenEncrypted", "Authorization", "DATABASE_URL", "REDIS_PASSWORD",
    "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "SOURCE_CONNECTION_ENCRYPTION_KEY", "stack", ...sentinels,
  ]) assert.equal(serialized.includes(forbidden), false, `preflight response leaked ${forbidden}`);
  assert.equal(/"(?:token|pat|password|ciphertext|authorization|cookie)"\s*:/i.test(serialized), false, "preflight response exposed a sensitive field");
  assert.equal(/https?:\/\/[^"\s]*@/i.test(serialized), false, "preflight response exposed credentialed URL syntax");
}
