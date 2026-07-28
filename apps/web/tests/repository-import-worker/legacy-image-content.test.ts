import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "@/app/api/images/[imageId]/content/route";

test("legacy image-content endpoint cannot fetch repository bytes or expose storage", async () => {
  const response = await GET();
  assert.equal(response.status, 410);
  const body = await response.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, "IMAGE_CONTENT_DEPRECATED");
  const serialized = JSON.stringify(body);
  for (const forbidden of ["token", "repository", "storage", "minio", "http", "stack"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false);
  }
});
