import { describe, expect, it } from "vitest";

import { sourceImportPreflightSchema, sourceImportStartSchema } from "@/lib/validation/source-connection";

const base = { provider: "GITEA", datasetName: "demo", credentialMode: "PUBLIC", serverUrl: "http://localhost:3300", repository: { owner: "o", repo: "r", ref: "main", expectedVisibility: "PUBLIC" } };

describe("source import preflight DTO", () => {
  it("accepts the modality the creation form sends with every preview (regression: 400 Unrecognized key \"modality\")", () => {
    for (const modality of ["IMAGE", "VIDEO", "AUDIO", "TEXT"]) expect(sourceImportPreflightSchema.safeParse({ ...base, modality }).success).toBe(true);
  });
  it("still accepts a request without modality (the preview does not use or infer it)", () => {
    expect(sourceImportPreflightSchema.safeParse(base).success).toBe(true);
  });
  it("rejects an invalid or empty modality instead of coercing it", () => {
    for (const modality of ["", "image", "DOCUMENT", null, 3]) expect(sourceImportPreflightSchema.safeParse({ ...base, modality }).success).toBe(false);
  });
  it("remains strict: every other unknown key is still rejected", () => {
    const result = sourceImportPreflightSchema.safeParse({ ...base, modality: "IMAGE", owner: "x" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? {} : result.error.issues)).toContain("owner");
  });
  it("keeps the credential-mode rules for the extended DTO", () => {
    expect(sourceImportPreflightSchema.safeParse({ ...base, modality: "IMAGE", serverUrl: undefined }).success).toBe(false);
    expect(sourceImportPreflightSchema.safeParse({ ...base, modality: "IMAGE", credentialMode: "ONE_TIME_PAT" }).success).toBe(false);
    expect(sourceImportPreflightSchema.safeParse({ ...base, modality: "IMAGE", sourceConnectionId: "abc" }).success).toBe(false);
  });
  it("leaves the deprecated start DTO exactly as strict as before (no modality key)", () => {
    expect(sourceImportStartSchema.safeParse(base).success).toBe(true);
    expect(sourceImportStartSchema.safeParse({ ...base, modality: "IMAGE" }).success).toBe(false);
  });
});
