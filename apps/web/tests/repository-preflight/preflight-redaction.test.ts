import assert from "node:assert/strict";
import test from "node:test";

import { safePreflightFailure, PreflightError } from "@/lib/providers/provider-errors";
import { assertNoPreflightSecret } from "./helpers";

test("safe semantic and operational failures contain no credential or stack sentinel", () => {
  const values = [
    safePreflightFailure(new PreflightError("SOURCE_TOKEN_EXPIRED")),
    safePreflightFailure(new Error("unexpected internal detail")),
  ];
  assertNoPreflightSecret(values, ["unexpected internal detail"]);
  assert.equal(JSON.stringify(values).includes("provider.example"), false);
});
