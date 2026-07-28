import assert from "node:assert/strict";
import test from "node:test";

import { jobQueuePayloadSchema } from "@fieldframe/queue";

import { buildDurableJobQueueDelivery } from "@/lib/queue/enqueue-job";
import {
  buildSafeRepositoryImportJobInput,
  creationRequestHash,
  isSafeRepositoryImportJobInput,
  reconcileDatasetCreationIdempotency,
} from "@/lib/repository-import/types";
import { repositoryImportRequestSchema } from "@/lib/validation/repository-import-request";

const baseRequest = {
  provider: "GITHUB" as const,
  credentialMode: "PUBLIC" as const,
  repository: {
    owner: "fixture",
    name: "public-images",
    repoUrl: "https://github.com/fixture/public-images",
    ref: "main",
    rootPath: "images",
    expectedVisibility: "PUBLIC" as const,
  },
  datasetName: "Phase 015 contract fixture",
  idempotencyKey: "phase015-idempotency-key-0001",
};

test("repository acceptance request is strict and cannot carry credentials or queue/storage controls", () => {
  assert.equal(repositoryImportRequestSchema.safeParse(baseRequest).success, true);
  assert.equal(repositoryImportRequestSchema.safeParse({
    ...baseRequest,
    repository: { ...baseRequest.repository, repoUrl: "http://github-fixture:8080/repos/fixture/public-images" },
  }).success, false, "browser identity must never become the server-only fixture API route");
  for (const forbidden of [
    { ...baseRequest, token: "must-not-accept" },
    { ...baseRequest, serverUrl: "https://provider.example" },
    { ...baseRequest, ownerId: "browser-owner" },
    { ...baseRequest, queueName: "fieldframe-jobs" },
    { ...baseRequest, storageKey: "private/object" },
    { ...baseRequest, manifest: { files: ["all-files-are-forbidden"] } },
  ]) assert.equal(repositoryImportRequestSchema.safeParse(forbidden).success, false);
});

test("hybrid credential modes allow only the approved fields and exclude a one-time PAT from the request hash", () => {
  const oneTime = repositoryImportRequestSchema.parse({
    provider: "GITEA",
    credentialMode: "ONE_TIME_PAT",
    serverUrl: "https://gitea.example.test",
    personalAccessToken: "phase015-pat-sentinel",
    saveAsSourceConnection: true,
    connectionName: "Phase 015 fixture",
    repository: { owner: "fixture", name: "private-images", ref: "main", expectedVisibility: "PRIVATE" },
    datasetName: "Private fixture",
    idempotencyKey: "phase015-idempotency-key-one-time",
  });
  assert.equal(repositoryImportRequestSchema.safeParse({ ...oneTime, saveAsSourceConnection: false }).success, true);
  assert.equal(repositoryImportRequestSchema.safeParse({ ...oneTime, connectionName: undefined }).success, false);
  assert.equal(repositoryImportRequestSchema.safeParse({
    ...baseRequest,
    credentialMode: "EXISTING_SOURCE_CONNECTION",
    sourceConnectionId: "connection-123",
    personalAccessToken: "must-not-accept",
  }).success, false);

  const withDifferentTransientPat = { ...oneTime, personalAccessToken: "another-pat-sentinel" };
  assert.equal(
    creationRequestHash(oneTime, null, "https://gitea.example.test"),
    creationRequestHash(withDifferentTransientPat, null, "https://gitea.example.test"),
    "the transient PAT must not affect durable creation idempotency",
  );
  assert.equal(JSON.stringify(oneTime).includes("phase015-pat-sentinel"), true, "test fixture only");
});

test("canonical request hash is stable for equivalent input and differs for a changed request", () => {
  const parsed = repositoryImportRequestSchema.parse(baseRequest);
  const equivalent = repositoryImportRequestSchema.parse({
    ...baseRequest,
    repository: {
      ...baseRequest.repository,
      owner: "FIXTURE",
      name: "PUBLIC-IMAGES",
      repoUrl: "https://github.com/FIXTURE/PUBLIC-IMAGES",
    },
  });
  const changed = repositoryImportRequestSchema.parse({ ...baseRequest, datasetName: "different Dataset" });
  assert.equal(creationRequestHash(parsed, "images"), creationRequestHash(equivalent, "images"));
  assert.notEqual(creationRequestHash(parsed, "images"), creationRequestHash(changed, "images"));
});

test("accepted Job input is deeply allowlisted and rejects credential-shaped values", () => {
  const input = buildSafeRepositoryImportJobInput({
    provider: "GITHUB",
    owner: "fixture",
    repo: "public-images",
    ref: "resolved-commit-sha",
    normalizedRootPath: "images",
    visibility: "PUBLIC",
    sourceConnectionId: null,
    manifest: { itemCount: 0, declaredBytes: 0 },
  });
  assert.equal(isSafeRepositoryImportJobInput(input), true);
  assert.equal(JSON.stringify(input).includes("token"), false);
  assert.equal(JSON.stringify(input).includes("baseUrl"), false);
  assert.equal(JSON.stringify(input).includes("queue"), false);

  assert.equal(isSafeRepositoryImportJobInput({
    ...input,
    source: { ...input.source, sourceConnectionId: { token: "must-not-pass" } },
  }), false);
  assert.equal(isSafeRepositoryImportJobInput({
    ...input,
    source: { ...input.source, manifest: { itemCount: 0, declaredBytes: 0, token: "must-not-pass" } },
  }), false);
  assert.equal(isSafeRepositoryImportJobInput({
    ...input,
    source: { ...input.source, repository: { ...input.source.repository, rootPath: { url: "must-not-pass" } } },
  }), false);
  assert.equal(isSafeRepositoryImportJobInput({
    ...input,
    source: { ...input.source, manifest: { itemCount: 0, declaredBytes: 0 }, unexpected: true },
  }), false);
  assert.equal(isSafeRepositoryImportJobInput({
    ...input,
    source: { ...input.source, repository: { ...input.source.repository, ref: "" } },
  }), false);
  assert.equal(isSafeRepositoryImportJobInput({
    ...input,
    source: { ...input.source, sourceConnectionId: "" },
  }), false);
});

test("idempotency reconciliation reuses only the exact durable acceptance and conflicts otherwise", () => {
  const durableJob = { id: "job-phase015-reused" };
  assert.deepEqual(reconcileDatasetCreationIdempotency(null, "request-hash"), { kind: "absent" });
  assert.deepEqual(
    reconcileDatasetCreationIdempotency({ creationRequestHash: "request-hash", job: durableJob }, "request-hash"),
    { kind: "reused", job: durableJob },
  );
  assert.deepEqual(
    reconcileDatasetCreationIdempotency({ creationRequestHash: "different-hash", job: durableJob }, "request-hash"),
    { kind: "conflict" },
  );
  // An incomplete Dataset acceptance cannot manufacture a second Job.
  assert.deepEqual(
    reconcileDatasetCreationIdempotency({ creationRequestHash: "request-hash", job: null }, "request-hash"),
    { kind: "conflict" },
  );
});

test("queue delivery construction is exactly { jobId }", () => {
  const delivery = buildDurableJobQueueDelivery("job-phase015-contract");
  assert.equal(delivery.name, "durable-job");
  assert.equal(delivery.queueJobId, "job-phase015-contract");
  assert.deepEqual(delivery.payload, { jobId: "job-phase015-contract" });

  const payload = jobQueuePayloadSchema.parse({ jobId: "job-phase015-contract" });
  assert.deepEqual(payload, { jobId: "job-phase015-contract" });
  assert.equal(jobQueuePayloadSchema.safeParse({ jobId: "job-phase015-contract", input: {} }).success, false);
});
