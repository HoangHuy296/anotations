import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Offline guards for the A2.2 M26 CANDIDATE: byte pins, additive-only shape, the frozen field list and the "not yet promoted" invariant. The database
// proof is scripts/db-safety/a2-chain.mjs (receipt-bound, disposable). Run: node --test scripts/db-safety/tests/a2-chain.test.mjs
const root = new URL("../../../", import.meta.url).pathname;
const read = path => readFileSync(join(root, path));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const chain = read("scripts/db-safety/a2-chain.mjs").toString("utf8");
const pin = key => new RegExp(`${key}: '([0-9a-f]{64})'`).exec(chain)?.[1];
const dir = "specs/proposals/phase029-a2-media-verification";
const m26 = `${dir}/20261007000000_media_verification_a2/migration.sql`;
const promoted = "prisma/migrations/20261007000000_media_verification_a2/migration.sql";

test("the candidate migration and candidate schema match the pins in the chain plan", () => {
  assert.equal(sha(read(m26)), pin("sha256"));
  assert.equal(sha(read(`${dir}/schema.candidate.prisma`)), pin("candidateSchemaSha256"));
  assert.deepEqual(readdirSync(join(root, dir, "20261007000000_media_verification_a2")), ["migration.sql"]);
});

test("A2.3: M26 is promoted into prisma/migrations with exactly the reviewed bytes; the chain is 26; M24 and M25 are byte-identical to their pins", () => {
  const active = readdirSync(join(root, "prisma/migrations"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.equal(active.length, 26);
  assert.equal(active.at(-1), "20261007000000_media_verification_a2");
  assert.equal(sha(read(promoted)), pin("sha256"), "the promoted bytes are the pinned bytes");
  assert.equal(sha(read(promoted)), sha(read(m26)), "the proposal copy (review record) is byte-identical to the promoted migration");
  assert.deepEqual(readdirSync(join(root, "prisma/migrations/20261007000000_media_verification_a2")), ["migration.sql"]);
  assert.equal(sha(read("prisma/migrations/20260930030000_dataset_modality_g2/migration.sql")), "13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7");
  assert.equal(sha(read("prisma/migrations/20261006000000_prepared_import_creation_request_hash/migration.sql")), "a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859");
});

test("M26 contains only the frozen creation statements: 2 enums, one ADD VALUE used nowhere else, 1 table, 8 indexes, 5 foreign keys", () => {
  const sql = read(m26).toString("utf8");
  const statements = sql.split("\n").filter(line => !line.startsWith("--")).join("\n").split(/;\s*(?:\n|$)/).map(text => text.trim()).filter(Boolean);
  assert.equal(statements.length, 17);
  const count = rx => statements.filter(text => rx.test(text)).length;
  assert.equal(count(/^CREATE TYPE "MediaVerification(Source|Status)" AS ENUM/), 2);
  assert.equal(count(/^ALTER TYPE "JobType" ADD VALUE 'VERIFY_UPLOADED_MEDIA'$/), 1);
  assert.equal(count(/^CREATE TABLE "MediaVerification" \(/), 1);
  assert.equal(count(/^CREATE (UNIQUE )?INDEX /), 8);
  assert.equal(count(/^ALTER TABLE "MediaVerification" ADD CONSTRAINT .* FOREIGN KEY /), 5);
  assert.equal((sql.match(/VERIFY_UPLOADED_MEDIA/g) ?? []).length, 1, "PostgreSQL forbids using a new enum value in the transaction that adds it");
  assert.equal(/\b(DROP|TRUNCATE|DELETE FROM|RENAME)\b/i.test(sql), false);
  assert.equal(/\bCHECK\b|CREATE (OR REPLACE )?(FUNCTION|TRIGGER)/i.test(sql), false, "frozen contract: no DB-level verification invariant");
});

test("A2.3: the tracked schema equals the candidate schema and is a purely additive superset of the M25 schema (read from the immutable M25 commit)", () => {
  const m25 = execFileSync("git", ["show", "c46c928e07a5cfeac2672532066a28bea3755c52:prisma/schema.prisma"], { cwd: root, encoding: "utf8" });
  assert.equal(sha(m25), "4fe3d96a334e18e504ea14fd5519a1a363fae5ea6d9845355c9d548698eed174");
  const tracked = read("prisma/schema.prisma").toString("utf8");
  assert.equal(sha(tracked), pin("candidateSchemaSha256"));
  assert.equal(tracked, read(`${dir}/schema.candidate.prisma`).toString("utf8"), "tracked schema equals the reviewed candidate");
  const trackedLines = new Set(tracked.split("\n"));
  assert.deepEqual(m25.split("\n").filter(line => line.trim() && !trackedLines.has(line)), [], "every M25 schema line survives unchanged");
  assert.match(tracked, /model MediaVerification \{/);
});
