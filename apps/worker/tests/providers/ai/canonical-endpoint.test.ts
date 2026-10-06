import "../../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: no database is opened).
import assert from "node:assert/strict";
import test from "node:test";
import { readAiProviderBaseUrl } from "@annotationplatform/domain/provider-config";
import { getAiozAnnotationServicesConfig } from "../../../src/config.js";

// The web catalog and the worker submission both resolve the provider through the one shared reader: same environment, same origin.
const env = (extra: Record<string, string> = {}) => ({ AIOZ_ANNOTATION_SERVICES_URL: "http://canonical.example.test:7000", AIOZ_COMPANY_API_KEY: "test-key", ...extra }) as NodeJS.ProcessEnv;

test("web and worker resolve exactly the same canonical endpoint from AIOZ_ANNOTATION_SERVICES_URL", () => {
  const e = env();
  assert.equal(getAiozAnnotationServicesConfig(e).baseUrl, readAiProviderBaseUrl(e));
  assert.equal(new URL(getAiozAnnotationServicesConfig(e).baseUrl).origin, "http://canonical.example.test:7000");
});

test("the canonical variable wins over legacy aliases for both processes, and a missing endpoint fails closed with no default host", () => {
  const e = env({ AIOZ_COMPANY_API_BASE_URL: "http://alias.example.test:8000" });
  assert.equal(new URL(getAiozAnnotationServicesConfig(e).baseUrl).origin, "http://canonical.example.test:7000");
  const none = { AIOZ_COMPANY_API_KEY: "test-key" } as NodeJS.ProcessEnv;
  assert.throws(() => readAiProviderBaseUrl(none));
  assert.throws(() => getAiozAnnotationServicesConfig(none), /AIOZ_CONFIG_INVALID/);
});
