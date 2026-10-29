import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: no database is opened).
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import type { Client as MinioClient } from "minio";

import { UploadVerificationFailure, verifyUploadedObject } from "@/lib/upload-verification";
import { MAX_DIRECT_UPLOAD_BYTES } from "@/lib/validation/upload";

// T021 (web side), offline: the production byte verifier runs unmodified against an in-memory object store. No database, network or MinIO.
// DB-backed publication/replay of the same boundary is covered by `verify:ingestion-replay-summary` and the direct-upload suite.

type Stored = { bytes: Buffer; size?: number; etag?: string };
function store(objects: Record<string, Stored>, failures: { stat?: boolean; read?: boolean } = {}) {
  return {
    statObject: async (_bucket: string, key: string) => { if (failures.stat || !objects[key]) throw new Error("NoSuchKey"); return { size: objects[key].size ?? objects[key].bytes.length, etag: objects[key].etag ?? "etag-1" }; },
    getPartialObject: async (_bucket: string, key: string, offset: number, length: number) => { if (failures.read) throw new Error("read failed"); return Readable.from([objects[key]!.bytes.subarray(offset, offset + length)]); },
  } as unknown as MinioClient;
}
const verify = (bytes: Buffer, candidate: string, key = "k", opts: { size?: number; etag?: string } = {}) =>
  verifyUploadedObject(store({ [key]: { bytes, ...opts } }), "bucket", key, opts.size ?? bytes.length, candidate);
const code = (promise: Promise<unknown>) => promise.then(() => "ACCEPTED", (error) => (error instanceof UploadVerificationFailure ? error.code : `UNEXPECTED:${(error as Error).name}:${(error as Error).message}`));

const png = (width = 2, height = 2) => { const b = Buffer.alloc(32); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); return b; };
const riff = (kind: string) => { const b = Buffer.alloc(32); b.write("RIFF", 0, "ascii"); b.write(kind, 8, "ascii"); return b; };
const iso = (brand: string) => { const b = Buffer.alloc(32); b.writeUInt32BE(24, 0); b.write("ftyp", 4, "ascii"); b.write(brand, 8, "ascii"); return b; };

test("spoofed MIME/extension: the verified modality comes from the bytes; a declared type can neither upgrade nor force a class", async () => {
  assert.equal((await verify(png(), "audio/wav")).modality, "IMAGE", "PNG bytes declared as audio are IMAGE (the publisher then rejects the mismatch against the parent)");
  assert.equal((await verify(riff("WAVE"), "image/png")).modality, "AUDIO", "WAV bytes declared as image are AUDIO");
  assert.equal((await verify(Buffer.from("plain text body\n"), "text/plain")).modality, "TEXT");
  assert.equal(await code(verify(Buffer.from("plain text body\n"), "image/png")), "UNSUPPORTED_MEDIA", "text bytes declared as an image are never TEXT");
  assert.equal(await code(verify(Buffer.from("plain text body\n"), "video/mp4")), "UNSUPPORTED_MEDIA", "text bytes declared as video are refused");
  assert.equal(await code(verify(Buffer.from([0, 1, 2, 3, 254, 253, 252]), "text/plain")), "UNSUPPORTED_MEDIA", "binary declared as text is refused");
  assert.equal(await code(verify(Buffer.from("ok\u0000hidden"), "text/plain")), "UNSUPPORTED_MEDIA", "NUL byte disqualifies text");
  assert.equal(await code(verify(Buffer.from([0xc3, 0x28, 0x41]), "application/json")), "UNSUPPORTED_MEDIA", "invalid UTF-8 declared as JSON is refused");
});

test("ambiguous containers fail closed on the synchronous upload path: no container is ever accepted as VIDEO or a guessed class", async () => {
  for (const [label, bytes] of [["ISO BMFF mp4", iso("isom")], ["ISO BMFF heic", iso("heic")], ["Ogg", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(28, 1)])], ["Matroska/WebM", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28, 1)])], ["ZIP", Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(28, 1)])], ["PDF", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(20, 1)])], ["RIFF AVI", riff("AVI ")]] as const) {
    for (const declared of ["video/mp4", "application/octet-stream", "image/png"]) assert.equal(await code(verify(bytes, declared)), "UNSUPPORTED_MEDIA", `${label} declared ${declared}`);
  }
});

test("malformed or truncated media is a controlled rejection, never an unexpected exception", async () => {
  assert.equal(await code(verify(Buffer.alloc(0), "image/png", "k", { size: 0 })), "UPLOAD_NOT_READY", "an empty object is not ready");
  const header = png().subarray(0, 8);
  assert.equal(await code(verify(header, "image/png")), "INVALID_MEDIA", "a PNG signature with no IHDR is malformed media, not an out-of-range read");
  assert.equal(await code(verify(png().subarray(0, 20), "image/png")), "INVALID_MEDIA");
});

test("source identity: the fingerprint binds object key, ETag and size; a replaced or resized object is a different source and a size/stat change is not ready", async () => {
  const a = await verify(png(), "image/png", "k", { etag: "etag-1" });
  assert.equal((await verify(png(), "image/png", "k", { etag: "etag-1" })).sourceFingerprint, a.sourceFingerprint, "same object, same fingerprint (replay-stable)");
  assert.notEqual((await verify(png(), "image/png", "k", { etag: "etag-2" })).sourceFingerprint, a.sourceFingerprint, "replaced content (new ETag) is a new source");
  assert.notEqual((await verify(png(), "image/png", "other-key", { etag: "etag-1" })).sourceFingerprint, a.sourceFingerprint, "another key is another source");
  assert.notEqual((await verify(Buffer.concat([png(), Buffer.alloc(8)]), "image/png", "k", { etag: "etag-1" })).sourceFingerprint, a.sourceFingerprint, "a different size is another source");
  assert.equal(a.sizeBytes, BigInt(32));
  // declared size disagrees with the stored object (object changed after the capability was issued)
  assert.equal(await code(verifyUploadedObject(store({ k: { bytes: png() } }), "bucket", "k", 31, "image/png")), "UPLOAD_NOT_READY");
  assert.equal(await code(verifyUploadedObject(store({ k: { bytes: png() } }, { stat: true }), "bucket", "k", 32, "image/png")), "UPLOAD_NOT_READY", "missing object");
  assert.equal(await code(verifyUploadedObject(store({ k: { bytes: png() } }, { read: true }), "bucket", "k", 32, "image/png")), "UPLOAD_NOT_READY", "object unreadable after stat");
  const huge = MAX_DIRECT_UPLOAD_BYTES + 1;
  assert.equal(await code(verifyUploadedObject(store({ k: { bytes: png(), size: huge } }), "bucket", "k", huge, "image/png")), "UPLOAD_NOT_READY", "oversize object");
});

test("JPEG and WebP uploads report their pixel size (needed by COCO export); an unreadable size stays unknown, never invalid", async () => {
  const jpeg = (width: number, height: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const webpX = (width: number, height: number) => { const b = Buffer.alloc(40); b.write("RIFF", 0, "ascii"); b.writeUInt32LE(32, 4); b.write("WEBPVP8X", 8, "ascii"); b.writeUInt32LE(10, 16); b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3); return b; };
  assert.deepEqual(await verify(jpeg(640, 480), "image/jpeg"), { ...(await verify(jpeg(640, 480), "image/jpeg")), modality: "IMAGE", mimeType: "image/jpeg", width: 640, height: 480 });
  const webp = await verify(webpX(1024, 768), "image/webp");
  assert.equal(webp.mimeType, "image/webp"); assert.equal(webp.width, 1024); assert.equal(webp.height, 768);
  // A JPEG whose frame header is not inside the inspected prefix is still a valid JPEG; its size is simply unknown.
  const noFrame = await verify(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]), "image/jpeg");
  assert.equal(noFrame.mimeType, "image/jpeg"); assert.equal(noFrame.width, undefined); assert.equal(noFrame.height, undefined);
});
