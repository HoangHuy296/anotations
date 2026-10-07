import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clientKnowsVerifyJobType, evaluateConsumers } from "../a2-release-guard.mjs";

// Offline. The release guard is what stands between the M26 enum addition and a consumer that cannot read the new Job type; the static scan proves that this increment
// creates no verification Job anywhere. Run: node --test scripts/db-safety/tests/a2-release-guard.test.mjs
const root = new URL("../../../", import.meta.url).pathname;
const snapshot = commit => { const dir = mkdtempSync(join(tmpdir(), "a2-guard-")); const archive = execFileSync("git", ["archive", commit, "--", "lib/generated/prisma"], { cwd: root, maxBuffer: 256 * 1024 * 1024 }); execFileSync("tar", ["-x", "-C", dir], { input: archive }); return dir; };

test("the M25-generated client does not know VERIFY_UPLOADED_MEDIA; the regenerated tracked client does", () => {
  assert.equal(clientKnowsVerifyJobType(snapshot("c46c928e07a5cfeac2672532066a28bea3755c52")), false);
  assert.equal(clientKnowsVerifyJobType(root), true);
});

test("the guard passes only when EVERY named consumer knows the value, and refuses an empty list", () => {
  const probes = { image: image => image.includes("new"), tree: tree => tree.includes("new") };
  assert.deepEqual(evaluateConsumers({ images: ["web:new", "worker:new"], trees: ["/x/new"] }, probes), { ok: true, offenders: [] });
  assert.deepEqual(evaluateConsumers({ images: ["web:new", "worker:old"] }, probes), { ok: false, offenders: ["image:worker:old"] });
  assert.deepEqual(evaluateConsumers({ images: ["web:old"], trees: ["/x/old"] }, probes), { ok: false, offenders: ["image:web:old", "tree:/x/old"] });
  assert.deepEqual(evaluateConsumers({}, probes), { ok: false, offenders: ["NO_CONSUMER_NAMED"] });
});

test("static scan: nothing in this increment CREATES a VERIFY_UPLOADED_MEDIA Job; the literal appears only in the contract, transport, router-guard and registration modules", () => {
  const allowed = new Set([
    "packages/domain/src/media-verification.ts", "packages/queue/src/job-contract.ts", "packages/queue/src/job-contract.test.ts",
    "apps/worker/src/queue/queue-router.ts", "apps/worker/src/jobs/media-verification-registration.ts",
  ]);
  const walk = dir => readdirSync(join(root, dir)).flatMap(name => { const rel = `${dir}/${name}`; if (["node_modules", "dist", ".next"].includes(name)) return []; return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel]; });
  const sources = ["apps/web/src", "apps/worker/src", "apps/realtime/src", "packages/domain/src", "packages/queue/src"].flatMap(walk).filter(file => /\.(ts|tsx|mjs|js)$/.test(file));
  const hits = sources.filter(file => /VERIFY_UPLOADED_MEDIA/.test(readFileSync(join(root, file), "utf8")));
  assert.deepEqual(hits.filter(file => !allowed.has(file)), [], "no creation site, no consumer and no web usage exists yet");
  for (const file of hits) assert.equal(/job\.create\(|jobType:|type:\s*["']VERIFY_UPLOADED_MEDIA["']\s*,\s*(modality|status)/.test(readFileSync(join(root, file), "utf8")), false, `${file} creates no Job`);
  assert.equal(readFileSync(join(root, "packages/domain/src/media-verification.ts"), "utf8").includes("export function createMediaVerificationJob"), false);
});
