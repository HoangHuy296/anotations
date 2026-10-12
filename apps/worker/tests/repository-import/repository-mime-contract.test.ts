import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: no database, network, object store or ffprobe is opened).
import assert from "node:assert/strict";
import test from "node:test";

import { correctRepositoryObjectContentType } from "../../src/jobs/repository-asset-mirror.js";
import { classifyDefinitiveHeader, classifyDefinitiveHeaderDetailed, classifyProbeDetailed, classifyProbeOutput, UNVERIFIED_CONTENT_TYPE } from "../../src/jobs/repository-media-classification.js";

// Repository MIME contract: the stored Content-Type and Asset.mimeType are what the BYTES prove. The extension only chooses candidates and the upload-time label.

const png = () => { const b = Buffer.alloc(32); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(2, 16); b.writeUInt32BE(2, 20); return b; };
const riff = (kind: string) => { const b = Buffer.alloc(32); b.write("RIFF", 0, "ascii"); b.write(kind, 8, "ascii"); return b; };
const probe = (formatName: string | undefined, kinds: string[]) => JSON.stringify({ streams: kinds.map((codec_type) => ({ codec_type })), ...(formatName === undefined ? {} : { format: { format_name: formatName } }) });

test("header-definitive formats carry the subtype the bytes prove, whatever the file was named", () => {
  assert.deepEqual(classifyDefinitiveHeaderDetailed(png()), { modality: "IMAGE", mimeType: "image/png" }, "PNG bytes named .jpg are image/png");
  assert.deepEqual(classifyDefinitiveHeaderDetailed(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), { modality: "IMAGE", mimeType: "image/jpeg" });
  assert.deepEqual(classifyDefinitiveHeaderDetailed(riff("WEBP")), { modality: "IMAGE", mimeType: "image/webp" });
  assert.deepEqual(classifyDefinitiveHeaderDetailed(riff("WAVE")), { modality: "AUDIO", mimeType: "audio/wav" }, "WAV bytes named .mp3 are audio/wav");
  assert.deepEqual(classifyDefinitiveHeaderDetailed(Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000")), { modality: "AUDIO", mimeType: "audio/mpeg" }, "MP3 bytes named .ogg are audio/mpeg");
  assert.deepEqual(classifyDefinitiveHeaderDetailed(Buffer.from("plain text\n")), { modality: "TEXT", mimeType: "text/plain" }, "csv/json subtypes are declarations the bytes cannot prove");
  assert.equal(classifyDefinitiveHeaderDetailed(Buffer.from("{not json")) ?.mimeType, "text/plain", "broken JSON named .json is text/plain, never application/json");
  assert.equal(classifyDefinitiveHeaderDetailed(Buffer.alloc(0)), null);
  assert.equal(classifyDefinitiveHeaderDetailed(Buffer.from([0, 1, 2, 3, 0xfe])), null);
});

test("the modality-only API is unchanged by the subtype detail", () => {
  for (const bytes of [png(), riff("WAVE"), riff("WEBP"), Buffer.from("text\n"), Buffer.from([0, 1, 2, 3, 0xfe])]) {
    assert.equal(classifyDefinitiveHeader(bytes), classifyDefinitiveHeaderDetailed(bytes)?.modality ?? null);
  }
});

test("container subtype comes from the probed format_name; a combination the contract does not name is an opaque download, not a guess", () => {
  assert.deepEqual(classifyProbeDetailed(probe("mov,mp4,m4a,3gp,3g2,mj2", ["video", "audio"])), { modality: "VIDEO", mimeType: "video/mp4" }, "WebM-named-.mp4 and MP4-named-.webm are decided here, not by the name");
  assert.deepEqual(classifyProbeDetailed(probe("matroska,webm", ["video"])), { modality: "VIDEO", mimeType: "video/webm" });
  assert.deepEqual(classifyProbeDetailed(probe("ogg", ["audio"])), { modality: "AUDIO", mimeType: "audio/ogg" });
  assert.deepEqual(classifyProbeDetailed(probe("mp3", ["audio"])), { modality: "AUDIO", mimeType: "audio/mpeg" });
  assert.deepEqual(classifyProbeDetailed(probe("wav", ["audio"])), { modality: "AUDIO", mimeType: "audio/wav" });
  for (const [format, kinds, modality] of [["avi", ["video"], "VIDEO"], ["mov,mp4,m4a,3gp,3g2,mj2", ["audio"], "AUDIO"], [undefined, ["video"], "VIDEO"], ["flac", ["audio"], "AUDIO"], ["matroska,webm", ["audio"], "AUDIO"]] as const) {
    assert.deepEqual(classifyProbeDetailed(probe(format, [...kinds])), { modality, mimeType: UNVERIFIED_CONTENT_TYPE }, `${format}/${kinds.join("+")}`);
  }
});

test("modality classification is unchanged and still fails closed", () => {
  assert.equal(classifyProbeOutput(probe("matroska,webm", ["video", "audio"])), "VIDEO");
  assert.equal(classifyProbeOutput(probe("ogg", ["audio"])), "AUDIO");
  for (const [output, code] of [[probe("x", ["data"]), "SOURCE_CONTENT_UNSUPPORTED"], [probe("x", ["subtitle"]), "SOURCE_CONTENT_UNSUPPORTED"], [probe("x", []), "SOURCE_CONTENT_UNSUPPORTED"], ["not json", "SOURCE_CONTENT_UNVERIFIED"], ["", "SOURCE_CONTENT_UNVERIFIED"]] as const) {
    assert.throws(() => classifyProbeDetailed(output), { message: code });
  }
});

test("the Content-Type correction refuses unapproved types and the sealed namespace before touching storage", async () => {
  for (const contentType of ["text/html", "image/svg+xml", "application/javascript", "", "IMAGE/PNG", "image/png\r\nX: 1"]) {
    await assert.rejects(correctRepositoryObjectContentType({ objectKey: "repository-mirror/a/b", contentType }), { message: "MINIO_CONTENT_TYPE_REFUSED" }, JSON.stringify(contentType));
  }
  await assert.rejects(correctRepositoryObjectContentType({ objectKey: "verified-uploads/x/y", contentType: "video/mp4" }), { message: "MINIO_CONTENT_TYPE_REFUSED" });
});
