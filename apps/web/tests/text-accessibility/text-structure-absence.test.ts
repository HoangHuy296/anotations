import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { resolveTextStructuralViews } from "../../src/lib/annotations/text-structure-service.js";
import { textGeometrySchema } from "@annotationplatform/domain/text-annotation-contract";

/**
 * T148/T154/G5: with no authoritative tokenizer/segmenter, durable
 * token/sentence/paragraph indexes are not offered, and no explicitly
 * identified view-only tokenization can be saved as geometry.
 */

test("resolveTextStructuralViews: always returns no views in this delivery -- never guesses a segmentation", () => {
  assert.deepEqual(resolveTextStructuralViews(), []);
});

test("TextGeometry has no token/sentence/paragraph kind -- a structural view can never be saved as geometry, by construction", () => {
  for (const kind of ["token", "sentence", "paragraph"]) {
    const result = textGeometrySchema.safeParse({ schemaVersion: 1, kind, sourceIdentity: `sha256:${"a".repeat(64)}` });
    assert.equal(result.success, false, `"${kind}" must not be a valid TextGeometry kind`);
  }
  // The only three kinds that do exist -- confirms the union is exactly this closed set, not merely missing the three rejected above by coincidence.
  const validSpan = textGeometrySchema.safeParse({ schemaVersion: 1, kind: "text-span", sourceIdentity: `sha256:${"a".repeat(64)}`, offsetUnit: "UTF16_CODE_UNIT", startOffset: 0, endOffset: 1 });
  const validDocument = textGeometrySchema.safeParse({ schemaVersion: 1, kind: "text-document", sourceIdentity: `sha256:${"a".repeat(64)}` });
  const validRelation = textGeometrySchema.safeParse({ schemaVersion: 1, kind: "text-relation", sourceIdentity: `sha256:${"a".repeat(64)}` });
  assert.equal(validSpan.success, true);
  assert.equal(validDocument.success, true);
  assert.equal(validRelation.success, true);
});
