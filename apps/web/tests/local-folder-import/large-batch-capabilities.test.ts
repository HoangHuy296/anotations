import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { hasImportIntegration } from "./helpers";
import { createLocalImportHttpFixture, type LocalImportHttpFixture, type UploadCapability } from "./http-fixtures";

let fixture: LocalImportHttpFixture | undefined;

before(async () => {
  if (hasImportIntegration) fixture = await createLocalImportHttpFixture(3116);
});
after(async () => fixture?.cleanup());

// Regression coverage for the mismatch between the import manifest's 1,000-item
// cap (spec SC-007) and upload-capabilities' old 100-item cap: any import past
// 100 files was silently stranded at 0% forever, because the browser requests
// every prepared item's capability in one call. 119 is chosen only to sit past
// the old cap; it is not itself significant.
const FILE_COUNT = 119;

test("a single-call capability request for a 119-file import succeeds, progress advances per item, and it auto-completes without a manual commit", { skip: !hasImportIntegration }, async () => {
  const app = fixture!;
  const items = Array.from({ length: FILE_COUNT }, (_, index) => ({ logicalPath: `batch/file-${index}.txt`, contentType: "text/plain" }));
  const preparation = await app.start({ items });
  assert.equal(preparation.items.length, FILE_COUNT);

  // The exact call the browser makes once, for every prepared item, right
  // after the durable Job exists (apps/web/src/components/imports/local-folder-import-form.tsx).
  const capabilityResponse = await app.capabilities(preparation.id, preparation.items.map((item) => item.id));
  assert.equal(capabilityResponse.status, 200, "a batch of 119 must not be rejected by the upload-capabilities cap");
  const capabilities = (await capabilityResponse.json() as { data: { capabilities: UploadCapability[] } }).data.capabilities;
  assert.equal(capabilities.length, FILE_COUNT);

  const cookie = await app.cookieFor("manager");
  async function readJob() {
    const response = await fetch(`${app.baseUrl}/api/jobs/${preparation.jobId}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return (await response.json() as { data: { status: string; progress: number | null; processedItems: number | null; totalItems: number | null } }).data;
  }

  const beforeUpload = await readJob();
  assert.equal(beforeUpload.processedItems ?? 0, 0);

  let sawMidwayAdvance = false;
  for (const [index, capability] of capabilities.entries()) {
    assert.ok((await app.postUpload(capability, "text/plain", `file-${index}.txt`)).ok);
    const completion = await app.complete(preparation.id, capability.itemId, capability.fileId);
    assert.equal(completion.status, 201);
    if (index === Math.floor(FILE_COUNT / 2)) {
      // Live progress: PostgreSQL is updated per item, not only at the end —
      // this is what /jobs/{jobId} polls to move its progress bar.
      const midway = await readJob();
      assert.ok((midway.processedItems ?? 0) >= index + 1, "processedItems must advance mid-batch, not only at completion");
      sawMidwayAdvance = true;
    }
  }
  assert.ok(sawMidwayAdvance);

  const afterUpload = await readJob();
  assert.equal(afterUpload.processedItems, FILE_COUNT);
  assert.equal(afterUpload.status, "RUNNING", "every item is durably accounted for, but nothing has committed it yet");

  // What the upload form now fires automatically right after its last item —
  // no manual "Commit import" click (apps/web/src/components/jobs/job-detail-client.tsx
  // also retries this same idempotent call on its own if it were ever lost).
  const commitResponse = await fetch(`${app.baseUrl}/api/jobs/${preparation.jobId}/commit-import`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(commitResponse.status, 200);

  const completed = await readJob();
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.progress, 100);
});
