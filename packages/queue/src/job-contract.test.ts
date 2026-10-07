import assert from "node:assert/strict";
import test from "node:test";

import { jobQueuePayloadSchema, queueNameForJobType, supportedQueueJobTypes } from "./job-contract.js";

test("media job types are transport-supported without widening the payload", () => {
  assert.ok(supportedQueueJobTypes.includes("EXTRACT_VIDEO_METADATA"));
  assert.ok(supportedQueueJobTypes.includes("GENERATE_AUDIO_WAVEFORM"));
  assert.equal(queueNameForJobType("GENERATE_AUDIO_WAVEFORM"), "fieldframe-jobs");
  assert.deepEqual(jobQueuePayloadSchema.parse({ jobId: "job_media_1" }), { jobId: "job_media_1" });
  assert.throws(() => jobQueuePayloadSchema.parse({ jobId: "job_media_1", assetId: "asset_secret" }));
});

test("VERIFY_UPLOADED_MEDIA is a transport-supported type whose payload is still strictly { jobId }", () => {
  assert.ok(supportedQueueJobTypes.includes("VERIFY_UPLOADED_MEDIA"));
  assert.equal(queueNameForJobType("VERIFY_UPLOADED_MEDIA"), "fieldframe-jobs");
  assert.equal(queueNameForJobType("VERIFY_UPLOADED_MEDIAS"), null);
  assert.deepEqual(jobQueuePayloadSchema.parse({ jobId: "job_verify_1" }), { jobId: "job_verify_1" });
  assert.throws(() => jobQueuePayloadSchema.parse({ jobId: "job_verify_1", verificationId: "v" }), "no verification detail may ride in the queue payload");
});
