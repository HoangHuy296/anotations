import assert from "node:assert/strict";
import test from "node:test";
import { getAiozAnnotationServicesConfig, getProductionHardeningPolicy } from "../src/config.js";
import { readAiProviderBaseUrl } from "@annotationplatform/domain/provider-config";

test("orphan cleanup defaults to dry-run and honors explicit true/false strings", () => {
  assert.equal(getProductionHardeningPolicy({}).MINIO_ORPHAN_SCAN_DRY_RUN, true);
  assert.equal(getProductionHardeningPolicy({ MINIO_ORPHAN_SCAN_DRY_RUN: "true" }).MINIO_ORPHAN_SCAN_DRY_RUN, true);
  assert.equal(getProductionHardeningPolicy({ MINIO_ORPHAN_SCAN_DRY_RUN: "false" }).MINIO_ORPHAN_SCAN_DRY_RUN, false);
  for (const value of ["", "0", "yes", "FALSE"]) {
    assert.throws(() => getProductionHardeningPolicy({ MINIO_ORPHAN_SCAN_DRY_RUN: value }));
  }
});

test("web and worker resolve the same explicit provider endpoint and aliases", () => {
  for (const key of ["AIOZ_ANNOTATION_SERVICES_URL", "AIOZ_ANNOTATION_SERVICES_BASE_URL", "AIOZ_COMPANY_API_BASE_URL"]) {
    const environment = { [key]: "https://ai.example.test", AIOZ_COMPANY_API_KEY: "test-only-key" };
    assert.equal(readAiProviderBaseUrl(environment), "https://ai.example.test");
    assert.equal(getAiozAnnotationServicesConfig(environment).baseUrl, readAiProviderBaseUrl(environment));
  }
  assert.equal(readAiProviderBaseUrl({ AIOZ_ANNOTATION_SERVICES_URL: "  ", AIOZ_COMPANY_API_BASE_URL: "https://fallback.example.test" }), "https://fallback.example.test");
  assert.equal(readAiProviderBaseUrl({ AIOZ_ANNOTATION_SERVICES_URL: "https://primary.example.test", AIOZ_COMPANY_API_BASE_URL: "https://legacy.example.test" }), "https://primary.example.test");
});

test("provider endpoint is required and failures never expose its value", () => {
  assert.throws(() => readAiProviderBaseUrl({}), /AIOZ_ANNOTATION_SERVICES_URL/);
  for (const endpoint of ["file:///private-path", "https://private-user:private-secret@example.test", "https://example.test?secret=private-value", "https://example.test#private-value"]) {
    assert.throws(() => readAiProviderBaseUrl({ AIOZ_ANNOTATION_SERVICES_URL: endpoint }), (error: Error) => {
      assert.equal(error.message.includes("private"), false);
      return true;
    });
  }
});
