import assert from "node:assert/strict";
import test from "node:test";
import { aiHttpEnabled, aiHttpSkipReason, request, signupAndLogin } from "./helpers";

// Live catalog assertions are opt-in, since the web server must reach AIOZ.
test("GET /api/ai/models filters the provider catalog by asset modality", {
  skip: aiHttpEnabled && process.env.AIOZ_CATALOG_HTTP_TESTS === "1" ? false : "Requires AI HTTP tests and AIOZ_CATALOG_HTTP_TESTS=1",
}, async () => {
  const owner = await signupAndLogin();
  const response = await request("/api/ai/models?modality=IMAGE", { headers: { Cookie: owner.cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { models: Array<Record<string, unknown>> } };
  for (const model of body.data.models) {
    assert.equal(model.modality, "IMAGE");
    assert.equal(typeof model.displayName, "string");
    assert.equal(typeof model.availableForTasks, "boolean");
    assert.equal("provider" in model, false);
  }
});

test("GET /api/ai/models rejects invalid modality", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const owner = await signupAndLogin();
  const response = await request("/api/ai/models?modality=INVALID", { headers: { Cookie: owner.cookie } });
  assert.equal(response.status, 400);
});

test("GET /api/ai/models requires authentication", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const response = await request("/api/ai/models");
  assert.equal(response.status, 401);
});
