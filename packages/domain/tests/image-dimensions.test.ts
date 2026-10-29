import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { readImageDimensions } from "../src/image-dimensions.js";

const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args, "-f", "image2pipe", "-"], { maxBuffer: 8 * 1024 * 1024 });
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("PNG, JPEG and WebP report their real pixel size from a real encoder", { skip: !hasFfmpeg }, () => {
  const source = ["-f", "lavfi", "-i", "testsrc=s=321x199", "-frames:v", "1"];
  assert.deepEqual(readImageDimensions(ffmpeg([...source, "-c:v", "png"])), { width: 321, height: 199 });
  assert.deepEqual(readImageDimensions(ffmpeg([...source, "-c:v", "mjpeg"])), { width: 321, height: 199 });
  assert.deepEqual(readImageDimensions(ffmpeg([...source, "-c:v", "libwebp"])), { width: 321, height: 199 });
  assert.deepEqual(readImageDimensions(ffmpeg([...source, "-c:v", "libwebp", "-lossless", "1"])), { width: 321, height: 199 });
});

test("a JPEG whose size lies after a large metadata segment is still read when the segment is inside the prefix", () => {
  const soi = [0xff, 0xd8]; const app1 = [0xff, 0xe1, 0x10, 0x02, ...new Array(0x1000).fill(0)]; const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  assert.deepEqual(readImageDimensions(Uint8Array.from([...soi, ...app1, ...sof0])), { width: 800, height: 600 });
});

test("truncated, hostile or unrelated prefixes yield null instead of throwing or guessing", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  assert.equal(readImageDimensions(png), null, "PNG header without the IHDR size");
  assert.equal(readImageDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff])), null, "JPEG segment longer than the prefix");
  assert.equal(readImageDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0, 0])), null, "zero dimensions");
  assert.equal(readImageDimensions(new TextEncoder().encode("plain text, not an image")), null);
  assert.equal(readImageDimensions(new Uint8Array(0)), null);
  const huge = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.equal(readImageDimensions(huge), null, "absurd dimensions are rejected");
});
