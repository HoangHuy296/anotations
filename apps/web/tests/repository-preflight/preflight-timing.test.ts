import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { db } from "@/lib/db";
import {
  assertNoPreflightSecret,
  assertNoPreflightWrite,
  preflightBusinessSnapshot,
  preflightHttpEnabled,
  preflightTransportSnapshot,
  registerAndLoginPreflightUser,
  removePreflightUser,
  sourceImportRequest,
} from "./helpers";
import {
  seedCorruptSourceConnection,
  seedExpiredSourceConnection,
  seedInvalidTokenSourceConnection,
  seedRevokedSourceConnection,
} from "./test-mode-fixtures";

const ITERATIONS = 30;
const MEDIAN_DELTA_THRESHOLD_MS = 100;

function percentile(samples: readonly number[], fraction: number) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

async function writeAggregateTimingReport(report: { maxMedianDeltaMs: number; thresholdMs: number; pass: boolean; groups: Record<string, { medianMs: number; p95Ms: number }> }) {
  const target = process.env.PHASE014_TIMING_REPORT_PATH;
  if (!target) return;
  assert.ok(target.startsWith("/tmp/"), "timing report path must remain in /tmp");
  // Aggregate-only output: never write individual request timings, responses,
  // cookies, repository URLs, connection IDs, or credentials.
  await writeFile(target, `${JSON.stringify(report)}\n`, { mode: 0o600 });
}

test("credential-invalid HTTP states stay within the controlled median timing threshold", {
  skip: preflightHttpEnabled
      && process.env.SOURCE_CONNECTION_TEST_MODE === "1"
      && process.env.PHASE014_TIMING_MATRIX === "1"
    ? false
    : "timing matrix requires explicit controlled Compose mode",
}, async () => {
  const actor = await registerAndLoginPreflightUser();
  const seeded: string[] = [];
  try {
    const [expired, revoked, corrupt, provider401] = await Promise.all([
      seedExpiredSourceConnection(actor.userId),
      seedRevokedSourceConnection(actor.userId),
      seedCorruptSourceConnection(actor.userId),
      seedInvalidTokenSourceConnection(actor.userId),
    ]);
    seeded.push(expired.id, revoked.id, corrupt.id, provider401.id);
    const before = { business: await preflightBusinessSnapshot(), transport: await preflightTransportSnapshot() };
    const groups = [
      ["expired", expired.id],
      ["revoked", revoked.id],
      ["corrupted", corrupt.id],
      ["provider401", provider401.id],
    ] as const;
    const aggregate: Record<string, { medianMs: number; p95Ms: number }> = {};
    let canonicalError: unknown;

    for (const [name, sourceConnectionId] of groups) {
      const samples: number[] = [];
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const startedAt = performance.now();
        const response = await sourceImportRequest("/api/source-import-preflight", actor.cookie, {
          provider: "GITEA",
          datasetName: "timing-matrix-must-not-persist",
          credentialMode: "EXISTING_SOURCE_CONNECTION",
          sourceConnectionId,
          repository: { owner: "annotation-admin", repo: "ImageDataset", ref: "main", expectedVisibility: "PUBLIC" },
        });
        const body = await response.json();
        samples.push(performance.now() - startedAt);
        assert.equal(response.status, 422);
        assert.equal(body.error.code, "SOURCE_TOKEN_INVALID");
        assertNoPreflightSecret(body);
        if (canonicalError === undefined) canonicalError = body.error;
        else assert.deepEqual(body.error, canonicalError, `${name} must not expose a distinguishable error shape`);
      }
      aggregate[name] = { medianMs: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95) };
    }

    const medians = Object.values(aggregate).map((entry) => entry.medianMs);
    const maxMedianDeltaMs = Math.max(...medians) - Math.min(...medians);
    const pass = maxMedianDeltaMs <= MEDIAN_DELTA_THRESHOLD_MS;
    await writeAggregateTimingReport({ maxMedianDeltaMs, thresholdMs: MEDIAN_DELTA_THRESHOLD_MS, pass, groups: aggregate });
    assert.ok(pass, `credential-invalid median timing delta exceeded ${MEDIAN_DELTA_THRESHOLD_MS}ms`);
    assertNoPreflightWrite(before.business, await preflightBusinessSnapshot());
    assertNoPreflightWrite(before.transport, await preflightTransportSnapshot());
  } finally {
    await db.sourceConnection.deleteMany({ where: { id: { in: seeded } } });
    await removePreflightUser(actor.userId);
  }
});
