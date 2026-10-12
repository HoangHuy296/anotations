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

import { EXTENSION_CONTENT_TYPES, SUPPORTED_UPLOAD_CONTENT_TYPES, fileExtension, partitionUploadSelection, resolveUploadContentType, skippedFilesMessage } from "@/lib/imports/upload-content-type";

test("the client's supported declared types equal the server's allowlist exactly (no drift between picker, resolver and schema)", () => {
  assert.deepEqual([...SUPPORTED_UPLOAD_CONTENT_TYPES].sort(), [...candidateContentTypes].sort());
  for (const type of Object.values(EXTENSION_CONTENT_TYPES)) assert.equal(localFolderManifestItemSchema.safeParse({ logicalPath: "d/f", contentType: type, sizeBytes: 1, fingerprint }).success, true, type);
});

test("the declared type comes from the EXTENSION: an empty or wrong browser MIME can no longer hide a video, or default it to text/plain", () => {
  const cases: Array<[name: string, browser: string, expected: string]> = [
    ["clip.mp4", "", "video/mp4"], ["clip.MP4", "text/plain", "video/mp4"], ["a.webm", "application/octet-stream", "video/webm"],
    ["data.csv", "application/vnd.ms-excel", "text/csv"], ["voice.wav", "audio/x-wav", "audio/wav"], ["song.mp3", "audio/mp3", "audio/mpeg"],
    ["p.jpg", "image/pjpeg", "image/jpeg"], ["p.jpeg", "", "image/jpeg"], ["n.txt", "", "text/plain"], ["d.json", "text/json", "application/json"], ["deep/dir/photo.PNG", "image/png", "image/png"],
  ];
  for (const [name, browser, expected] of cases) assert.deepEqual(resolveUploadContentType({ name, type: browser }), { supported: true, contentType: expected, source: "extension" }, `${name} (${browser || "empty"})`);
});

test("unsupported files are reported and skipped instead of failing the whole manifest: mkv, ogg, m4a, flac, gif, exe, archives and unknown extensions", () => {
  for (const [name, browser] of [["a.mkv", "video/x-matroska"], ["a.ogg", "audio/ogg"], ["a.m4a", "audio/mp4"], ["a.flac", "audio/flac"], ["a.gif", "image/gif"], ["a.exe", "application/x-msdownload"], ["a.zip", "application/zip"], ["a.avif", "image/avif"], ["a.bin", ""]] as const) {
    const resolved = resolveUploadContentType({ name, type: browser });
    assert.equal(resolved.supported, false, name);
  }
  const { supported, skipped } = partitionUploadSelection([{ name: "ok.mp4", type: "" }, { name: "bad.mkv", type: "video/x-matroska" }, { name: "n.txt", type: "text/plain" }, { name: "x.ogg", type: "audio/ogg" }]);
  assert.deepEqual(supported.map((entry) => [entry.file.name, entry.contentType]), [["ok.mp4", "video/mp4"], ["n.txt", "text/plain"]]);
  assert.deepEqual(skipped.map((entry) => entry.name), ["bad.mkv", "x.ogg"]);
  assert.match(skippedFilesMessage(skipped)!, /^2 files were skipped because their type is not supported \(bad\.mkv, x\.ogg\)/);
  assert.equal(skippedFilesMessage([]), null);
});

test("extension-less files: the browser type is honored only when it is an exact supported type; an untyped one stays plain text; dot-files have no extension", () => {
  assert.deepEqual(resolveUploadContentType({ name: "README", type: "" }), { supported: true, contentType: "text/plain", source: "browser" });
  assert.deepEqual(resolveUploadContentType({ name: "blob", type: "image/png" }), { supported: true, contentType: "image/png", source: "browser" });
  assert.equal(resolveUploadContentType({ name: "blob", type: "video/x-matroska" }).supported, false);
  assert.equal(fileExtension(".gitignore"), ""); assert.equal(fileExtension("a.tar.gz"), "gz"); assert.equal(fileExtension("dir.v2/file"), ""); assert.equal(fileExtension("trailing."), "");
});

test("the folder form uses the resolver (not file.type) and reports skipped files", () => {
  const form = readFileSync(new URL("../../src/components/imports/local-folder-import-form.tsx", import.meta.url), "utf8");
  assert.equal(form.includes('file.type || "text/plain"'), false, "the unreliable browser MIME is never the declared type");
  assert.match(form, /partitionUploadSelection\(selected\)/); assert.match(form, /skippedFilesMessage\(skipped\)/);
});
