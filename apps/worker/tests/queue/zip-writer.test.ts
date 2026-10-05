import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildZipArchive } from "../../src/jobs/zip-writer.js";

test("buildZipArchive produces a byte-identical archive on repeated calls (deterministic)", () => {
  const entries = [
    { path: "classes.txt", content: Buffer.from("cat\ndog\n", "utf8") },
    { path: "images/a/1.txt", content: Buffer.from("0 0.5 0.5 0.2 0.2\n", "utf8") },
  ];
  const first = buildZipArchive(entries);
  const second = buildZipArchive(entries.map((e) => ({ path: e.path, content: Buffer.from(e.content) })));
  assert.ok(first.equals(second));
});

test("buildZipArchive supports a zero-byte entry (the zero-annotation-image case)", () => {
  const zip = buildZipArchive([{ path: "empty.txt", content: Buffer.alloc(0) }]);
  assert.ok(zip.byteLength > 0);
});

test("buildZipArchive output is readable by a real, independent unzip implementation", { skip: (() => { try { execFileSync("unzip", ["-v"]); return false; } catch { return "unzip is not installed"; } })() }, () => {
  const dir = mkdtempSync(join(tmpdir(), "zip-writer-test-"));
  const zipPath = join(dir, "archive.zip");
  try {
    const zip = buildZipArchive([
      { path: "classes.txt", content: Buffer.from("cat\ndog\n", "utf8") },
      { path: "images/a/1.txt", content: Buffer.from("0 0.5 0.5 0.2 0.2\n", "utf8") },
      { path: "images/b/1.txt", content: Buffer.alloc(0) },
    ]);
    writeFileSync(zipPath, zip);
    // Integrity check via a real, independent implementation -- not just
    // "the bytes look plausible".
    const output = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    assert.match(output, /No errors detected/);
    const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
    assert.match(listing, /classes\.txt/);
    assert.match(listing, /images\/a\/1\.txt/);
    assert.match(listing, /images\/b\/1\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
