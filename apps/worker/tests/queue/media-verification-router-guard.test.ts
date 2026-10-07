import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: the database is a recording fake).
import assert from "node:assert/strict";
import test from "node:test";

import { MEDIA_VERIFICATION_PROCESSOR_REGISTERED } from "../../src/jobs/media-verification-registration.js";
import { routeQueueDelivery } from "../../src/queue/queue-router.js";

// A2 foundation: VERIFY_UPLOADED_MEDIA is transport-supported but has no processor. The router must refuse it BEFORE claiming, so such a Job can never be left RUNNING.
function fakeDb(type: string) {
  const events: unknown[] = []; const claims: unknown[] = [];
  const db = {
    job: {
      findUnique: async () => ({ id: "job-1", type, status: "QUEUED", cancelRequestedAt: null, sourceConnectionId: null, dataset: { archivedAt: null, deletedAt: null } }),
      updateMany: async (arg: unknown) => { claims.push(arg); return { count: 1 }; }, findFirst: async () => null,
    },
    jobEvent: { create: async (arg: unknown) => { events.push(arg); return arg; } },
  };
  return { db: db as never, events, claims };
}

test("no processor is registered in this increment", () => assert.equal(MEDIA_VERIFICATION_PROCESSOR_REGISTERED, false));

test("a delivered VERIFY_UPLOADED_MEDIA Job is skipped as UNSUPPORTED_TYPE before any claim, with a safe QUEUE_SKIPPED event", async () => {
  const { db, events, claims } = fakeDb("VERIFY_UPLOADED_MEDIA");
  const result = await routeQueueDelivery({ db, payload: { jobId: "job-1" } });
  assert.deepEqual(result, { kind: "skipped", reason: "UNSUPPORTED_TYPE" });
  assert.equal(claims.length, 0, "never claimed");
  assert.equal(events.length, 1);
  assert.match(JSON.stringify(events[0]), /QUEUE_SKIPPED/);
});

test("an unknown job type is still refused, and the queue payload still carries only { jobId }", async () => {
  const { db, claims } = fakeDb("NOT_A_REAL_TYPE");
  assert.deepEqual(await routeQueueDelivery({ db, payload: { jobId: "job-1" } }), { kind: "skipped", reason: "UNSUPPORTED_TYPE" });
  assert.equal(claims.length, 0);
  assert.deepEqual(await routeQueueDelivery({ db: fakeDb("VERIFY_UPLOADED_MEDIA").db, payload: { jobId: "job-1", verificationId: "v" } }), { kind: "skipped", reason: "MALFORMED_PAYLOAD" });
});
