import assert from "node:assert/strict";
import test from "node:test";

import { JobStatus, JobType } from "@internal/db";

import {
  assertNoRepositoryImportSecret,
  cleanupRepositoryImportUser,
  createOwnedRepositoryImportGiteaConnection,
  getRepositoryImportJob,
  publicGiteaRequest,
  publicGithubRequest,
  repositoryImportHttpEnabled,
  repositoryImportHttpSkipReason,
  repositoryImportRequest,
  repositoryImportSnapshot,
  type RepositoryImportRequestBody,
  registerAndLoginRepositoryImportUser,
  safeQueueInspector,
  uniqueRepositoryImportKey,
} from "./helpers";

type AcceptedResponse = {
  data?: {
    dataset?: { id?: string; name?: string };
    job?: { id?: string; datasetId?: string; type?: string; status?: string };
    progressPath?: string;
  };
  error?: { code?: string };
};

function assertSafeAcceptedResponse(payload: AcceptedResponse, sentinels: readonly string[] = []) {
  assert.deepEqual(Object.keys(payload).sort(), ["data"]);
  assert.deepEqual(Object.keys(payload.data ?? {}).sort(), ["dataset", "job", "progressPath"]);
  assert.deepEqual(Object.keys(payload.data?.dataset ?? {}).sort(), ["id", "name"]);
  assert.deepEqual(Object.keys(payload.data?.job ?? {}).sort(), ["datasetId", "id", "status", "type"]);
  assertNoRepositoryImportSecret(payload, sentinels);
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["input", "state", "result", "queueName", "queueJobId", "storage", "baseUrl", "externalRepository", "sourceConnection"]) {
    assert.equal(serialized.includes(forbidden), false, `accepted response leaked ${forbidden}`);
  }
}

/**
 * A broken Compose web process can close a response before Next writes its
 * JSON error envelope. Surface only the status and byte count here—never raw
 * response text, which might contain an unexpected provider diagnostic.
 */
async function readSafeResponse(response: Response): Promise<AcceptedResponse> {
  const text = await response.text();
  try {
    return JSON.parse(text) as AcceptedResponse;
  } catch {
    assert.fail(`repository acceptance returned a non-JSON response (HTTP ${response.status}, ${text.length} bytes)`);
  }
}

async function assertAcceptedImport(
  cookie: string,
  body: RepositoryImportRequestBody,
  options: { sourceConnectionId?: string; sentinels?: readonly string[] } = {},
) {
  const before = await repositoryImportSnapshot();
  const response = await repositoryImportRequest(cookie, body);
  const payload = await readSafeResponse(response);
  assert.equal(response.status, 202, `repository acceptance failed with ${payload.error?.code ?? "unknown"}`);
  assert.ok(payload.data?.dataset?.id);
  assert.ok(payload.data?.job?.id);
  assert.equal(payload.data?.job?.datasetId, payload.data?.dataset?.id);
  assert.equal(payload.data?.job?.type, "IMPORT_DATASET");
  assert.equal(payload.data?.job?.status, "QUEUED");
  assert.equal(payload.data?.progressPath, `/datasets/${payload.data.dataset.id}/imports/${payload.data.job.id}`);
  assertSafeAcceptedResponse(payload, options.sentinels);

  const job = await getRepositoryImportJob(payload.data.job.id);
  assert.equal(job.datasetId, payload.data.dataset.id);
  assert.equal(job.type, JobType.IMPORT_DATASET);
  assert.equal(job.status, JobStatus.QUEUED);
  assert.equal(job.idempotencyKey, body.idempotencyKey);
  assert.equal(job.sourceConnectionId, options.sourceConnectionId ?? null);
  assert.equal(JSON.stringify(job.input).includes("token"), false);
  assert.equal(JSON.stringify(job.input).includes("baseUrl"), false);

  const after = await repositoryImportSnapshot();
  assert.equal(after.datasetIds.length, before.datasetIds.length + 1);
  assert.equal(after.jobIds.length, before.jobIds.length + 1);
  assert.equal(after.jobEventIds.length, before.jobEventIds.length + 1);
  assert.deepEqual(after.sourceConnectionIds, before.sourceConnectionIds, "public acceptance must not create a SourceConnection");
  assert.ok(after.datasetIds.includes(payload.data.dataset.id));
  assert.ok(after.jobIds.includes(job.id));
  return { jobId: job.id, datasetId: job.datasetId };
}

test("authenticated HTTP accepts public GitHub and public Gitea repository imports safely", {
  skip: repositoryImportHttpEnabled ? false : repositoryImportHttpSkipReason,
  concurrency: false,
}, async () => {
  const actor = await registerAndLoginRepositoryImportUser();
  const accepted: string[] = [];
  try {
    const github = await assertAcceptedImport(actor.cookie, publicGithubRequest());
    accepted.push(github.jobId);
    const gitea = await assertAcceptedImport(actor.cookie, publicGiteaRequest());
    accepted.push(gitea.jobId);
  } finally {
    const queue = safeQueueInspector();
    try { await Promise.all(accepted.map((id) => queue.removeJob(id))); } finally { await queue.close(); }
    await cleanupRepositoryImportUser(actor.userId);
  }
});

test("authenticated HTTP accepts an active owned private Gitea source connection without credential leakage", {
  skip: repositoryImportHttpEnabled && process.env.SOURCE_CONNECTION_GITEA_TOKEN
    ? false
    : "private repository acceptance requires the controlled Gitea fixture token and Phase-015 HTTP runtime",
  concurrency: false,
}, async () => {
  const actor = await registerAndLoginRepositoryImportUser();
  const accepted: string[] = [];
  try {
    const connectionId = await createOwnedRepositoryImportGiteaConnection(actor.cookie, process.env.SOURCE_CONNECTION_GITEA_TOKEN!);
    const request = publicGiteaRequest({
      credentialMode: "EXISTING_SOURCE_CONNECTION",
      sourceConnectionId: connectionId,
      datasetName: `phase015-private-${uniqueRepositoryImportKey("dataset")}`,
      idempotencyKey: uniqueRepositoryImportKey(),
      repository: {
        owner: "annotation-admin",
        name: "ImageDatasetPrivate",
        ref: "main",
        expectedVisibility: "PRIVATE",
      },
    });
    const result = await assertAcceptedImport(actor.cookie, request, {
      sourceConnectionId: connectionId,
      sentinels: [process.env.SOURCE_CONNECTION_GITEA_TOKEN!],
    });
    accepted.push(result.jobId);
    const job = await getRepositoryImportJob(result.jobId);
    assert.equal(job.sourceConnectionId, connectionId);
    assert.equal(JSON.stringify(job.input).includes(process.env.SOURCE_CONNECTION_GITEA_TOKEN!), false);
  } finally {
    const queue = safeQueueInspector();
    try { await Promise.all(accepted.map((id) => queue.removeJob(id))); } finally { await queue.close(); }
    await cleanupRepositoryImportUser(actor.userId);
  }
});
