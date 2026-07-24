import assert from "node:assert/strict";
import test from "node:test";

import { sourceImportPreflightSchema } from "@/lib/validation/source-connection";

const repository = {
  owner: "fixture",
  repo: "images",
  ref: "main",
  expectedVisibility: "PRIVATE" as const,
};

test("source import contract permits transient one-time PAT preflight but requires its save name when requested", () => {
  const transient = sourceImportPreflightSchema.safeParse({
    provider: "GITEA",
    datasetName: "fixture import",
    credentialMode: "ONE_TIME_PAT",
    serverUrl: "https://gitea.example.test",
    token: "test-token",
    saveAsSourceConnection: false,
    repository,
  });
  assert.equal(transient.success, true);

  const unnamedSave = sourceImportPreflightSchema.safeParse({
    provider: "GITEA",
    datasetName: "fixture import",
    credentialMode: "ONE_TIME_PAT",
    serverUrl: "https://gitea.example.test",
    token: "test-token",
    saveAsSourceConnection: true,
    repository,
  });
  assert.equal(unnamedSave.success, false);
});

test("source import contract keeps public and existing-connection modes mutually exclusive", () => {
  const publicWithCredential = sourceImportPreflightSchema.safeParse({
    provider: "GITEA",
    datasetName: "fixture import",
    credentialMode: "PUBLIC",
    serverUrl: "https://gitea.example.test",
    sourceConnectionId: "foreign-or-malformed-id",
    repository: { ...repository, expectedVisibility: "PUBLIC" },
  });
  assert.equal(publicWithCredential.success, false);

  const existing = sourceImportPreflightSchema.safeParse({
    provider: "GITEA",
    datasetName: "fixture import",
    credentialMode: "EXISTING_SOURCE_CONNECTION",
    sourceConnectionId: "owned-connection-id",
    repository,
  });
  assert.equal(existing.success, true);
});
