import assert from "node:assert/strict";
import test from "node:test";

import { createUploadCapability, verifyUploadCapability } from "@/lib/upload-capability";

const config = { UPLOAD_CAPABILITY_SECRET: "test-upload-capability-secret-that-is-long-enough" };

test("upload completion capability is encrypted, tamper-evident, and expires", () => {
  const capability = createUploadCapability(config, {
    actorId: "actor-id", datasetId: "dataset-id", filename: "folder/scene.png", candidateContentType: "image/png", sizeBytes: 24,
  });
  assert.equal(capability.token.includes("direct-uploads"), false);
  assert.equal(verifyUploadCapability(config, capability.token)?.objectKey, capability.payload.objectKey);
  const [iv, ciphertext, tag] = capability.token.split(".");
  const replacement = ciphertext[0] === "A" ? "B" : "A";
  assert.equal(verifyUploadCapability(config, `${iv}.${replacement}${ciphertext.slice(1)}.${tag}`), null);
  assert.equal(verifyUploadCapability(config, capability.token, capability.payload.expiresAt + 1), null);
});
