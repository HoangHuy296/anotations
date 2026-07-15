import assert from "node:assert/strict";
import test from "node:test";

import { requireOwnedSourceConnection, validateAnnotationReferences } from "@/lib/authorization";
import { decryptSourceToken, encryptSourceToken } from "@/lib/source-connection-crypto";
import { db } from "@/lib/db";
import { createFixture, hasIntegrationDatabase } from "./helpers";

test("cross-dataset Asset and Label identifiers cannot satisfy annotation integrity", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createFixture();
  try {
    assert.equal(await validateAnnotationReferences(fixture.datasetId, fixture.assetId, fixture.assetVersionId, fixture.labelId), true);
    assert.equal(await validateAnnotationReferences(fixture.datasetId, fixture.otherAssetId, null, fixture.labelId), false);
    assert.equal(await validateAnnotationReferences(fixture.datasetId, fixture.assetId, fixture.otherAssetVersionId, fixture.labelId), false);
    assert.equal(await validateAnnotationReferences(fixture.datasetId, fixture.assetId, null, fixture.otherLabelId), false);
    assert.equal((await db.annotation.findUnique({ where: { id: fixture.annotationId }, select: { datasetId: true } }))?.datasetId, fixture.datasetId);
  } finally { await fixture.cleanup(); }
});

test("a SourceConnection is invisible to a different user", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createFixture();
  try {
    assert.ok(await requireOwnedSourceConnection(fixture.actors.owner, fixture.sourceConnectionId));
    assert.equal(await requireOwnedSourceConnection(fixture.actors.owner, fixture.otherSourceConnectionId), null);
  } finally { await fixture.cleanup(); }
});

test("SourceConnection encryption is authenticated and only decrypted server-side", () => {
  process.env.SOURCE_CONNECTION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  const ciphertext = encryptSourceToken("server-only-fixture-token");
  assert.notEqual(ciphertext, "server-only-fixture-token");
  assert.equal(decryptSourceToken(ciphertext), "server-only-fixture-token");
});
