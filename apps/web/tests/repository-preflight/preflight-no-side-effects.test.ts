import test from "node:test";
import assert from "node:assert/strict";

import { assertNoPreflightSecret, assertNoPreflightWrite, preflightBusinessSnapshot, preflightHttpEnabled, preflightHttpSkipReason, preflightRequest, preflightTransportSnapshot, registerAndLoginPreflightUser, removePreflightUser } from "./helpers";

test("each rejected preflight leaves canonical IDs, isolated Redis, and MinIO unchanged", { skip: preflightHttpEnabled ? false : preflightHttpSkipReason }, async () => {
  const actor = await registerAndLoginPreflightUser();
  try {
    const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
    const response = await preflightRequest(actor.cookie, {
      provider: "GITHUB",
      repository: { owner: "fixture", name: "public-images" },
      ref: "missing-ref",
    });
    const body = await response.json();
    assert.equal(
      response.status,
      404,
      `missing-ref preflight failed with safe code ${String(body?.error?.code ?? "unknown")}`,
    );
    assert.equal(body.error.code, "REF_NOT_FOUND");
    assertNoPreflightSecret(body);
    assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
    assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
  } finally {
    await removePreflightUser(actor.userId);
  }
});
