import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: no database is opened).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { localFolderManifestItemSchema } from "@/lib/validation/local-folder-import";
import { candidateContentTypes, presignedUploadSchema } from "@/lib/validation/upload";

// A2 task A2-0 (contract D4/R7): `audio/ogg` is no longer advertised for direct or local-folder upload; Ogg stays deferred. Repository-import Ogg handling is a
// separate path and is deliberately untouched. VIDEO (mp4/webm) stays advertised: it is honored once A2 ships and is the expected 415 until then.
const dataset = "cmuwr6w8e000ipu0k3ng0ogr9";
const fingerprint = "a".repeat(64);

test("audio/ogg is not an advertised upload candidate type; video/mp4 and video/webm remain", () => {
  assert.equal((candidateContentTypes as readonly string[]).includes("audio/ogg"), false);
  for (const type of ["video/mp4", "video/webm", "audio/wav", "audio/mpeg", "image/png", "text/plain"]) assert.equal((candidateContentTypes as readonly string[]).includes(type), true, type);
});

test("direct and local-folder requests naming audio/ogg are refused at validation (early 400)", () => {
  assert.equal(presignedUploadSchema.safeParse({ datasetId: dataset, filename: "a.ogg", contentType: "audio/ogg", sizeBytes: 10 }).success, false);
  assert.equal(presignedUploadSchema.safeParse({ datasetId: dataset, filename: "v.mp4", contentType: "video/mp4", sizeBytes: 10 }).success, true);
  assert.equal(localFolderManifestItemSchema.safeParse({ logicalPath: "d/a.ogg", contentType: "audio/ogg", sizeBytes: 10, fingerprint }).success, false);
  assert.equal(localFolderManifestItemSchema.safeParse({ logicalPath: "d/v.webm", contentType: "video/webm", sizeBytes: 10, fingerprint }).success, true);
});

test("the OpenAPI documents no longer advertise audio/ogg and the folder picker narrows to supported types", () => {
  for (const file of ["../../specs/api/schemas/assets.yaml", "../../specs/api/schemas/import-repository.yaml"]) assert.equal(readFileSync(new URL(`../../../../${file.slice(6)}`, import.meta.url), "utf8").includes("audio/ogg"), false, file);
  const form = readFileSync(new URL("../../src/components/imports/local-folder-import-form.tsx", import.meta.url), "utf8");
  assert.equal(form.includes('accept="image/*,video/*,audio/*'), false);
  assert.match(form, /accept="image\/png,image\/jpeg,image\/webp,video\/mp4,video\/webm,audio\/wav,audio\/mpeg,text\/plain,text\/csv,application\/json/);
});
