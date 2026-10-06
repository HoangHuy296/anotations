import "../../../../scripts/db-safety/test-entry.cjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { db } from "@/lib/db";
import { APPROVED, DATASETS } from "./maintenance-fixture";

/**
 * Database-side checks of the maintenance rehearsal. The launcher is the only writer; this step only reads (and, at the end, proves immutability).
 * Driven by `maintenance-check.json` in the receipt's private stage: { phase, token }.
 */
const receipt = JSON.parse(readFileSync(process.env.DB_SAFETY_RECEIPT!, "utf8"));
const stage = dirname(receipt.config);
const { phase, token } = JSON.parse(readFileSync(join(stage, "maintenance-check.json"), "utf8")) as { phase: string; token?: string };
const ALL = DATASETS.map(spec => spec.id);
const RESOLVED_AFTER: Record<string, string[]> = {
  "after-observe": [], "after-apply-1": ["mn-a-image", "mn-b-video", "mn-c-audio", "mn-d-text", "mn-e-etag-match"],
  "after-apply-2": ["mn-a-image", "mn-b-video", "mn-c-audio", "mn-d-text", "mn-e-etag-match", "mn-m-mutate-size"],
  "after-apply-3": ["mn-a-image", "mn-b-video", "mn-c-audio", "mn-d-text", "mn-e-etag-match", "mn-m-mutate-size", "mn-n-mutate-etag"],
  "after-negative": [], final: APPROVED,
};
const canonical = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `bigint:${v}` : v));
const datasets = () => db.dataset.findMany({ where: { id: { in: ALL } }, orderBy: { id: "asc" } });
const assets = () => db.asset.findMany({ where: { datasetId: { in: ALL } }, orderBy: { id: "asc" } });
const side = async () => canonical({ jobs: await db.job.count(), imports: await db.preparedImport.count(), labels: await db.label.count(), assets: await db.asset.count(), datasets: await db.dataset.count() });

test(`database check: ${phase}`, async () => {
  try {
    if (phase === "snapshot") {
      writeFileSync(join(stage, "maintenance-snapshot.json"), canonical({ datasets: await datasets(), assets: await assets(), side: await side() }), { mode: 0o600 });
      assert.ok((await datasets()).every(row => row.modality === null && row.modalityContentRevision === BigInt(0)), "every fixture dataset starts unresolved at revision 0");
      return;
    }
    const before = JSON.parse(readFileSync(join(stage, "maintenance-snapshot.json"), "utf8")) as { datasets: Array<Record<string, unknown>>; assets: unknown; side: string };
    const resolvedIds = RESOLVED_AFTER[phase];
    assert.ok(resolvedIds, `known phase ${phase}`);
    const rows = await datasets();
    const subject = token ? `system:phase029-backfill:${token}` : null;
    const beforeById = new Map(before.datasets.map(row => [row.id as string, row]));
    for (const row of rows) {
      if (resolvedIds.includes(row.id)) {
        const spec = DATASETS.find(item => item.id === row.id)!;
        const assetModalities = new Set((await db.asset.findMany({ where: { datasetId: row.id }, select: { modality: true } })).map(asset => asset.modality));
        assert.equal(assetModalities.size, 1); assert.equal(row.modality, [...assetModalities][0], `${row.id}: modality equals the Asset modality`);
        assert.equal(row.modalityResolverSubject, subject, `${row.id}: opaque receipt subject`); assert.ok(row.modalityResolvedAt);
        assert.equal(row.modalityContentRevision, BigInt(1), `${row.id}: exactly one fence claim`);
        if (spec.primary) assert.equal(row.primaryModality, spec.primary, "the legacy primaryModality is untouched");
      } else {
        const original = beforeById.get(row.id)!;
        assert.equal(canonical(JSON.parse(canonical(row))), canonical(original), `${row.id}: not approved/not yet applied, so unchanged`);
        assert.equal(row.modality, null);
      }
    }
    assert.equal(canonical(JSON.parse(canonical(await assets()))), canonical(before.assets), "no Asset row changed");
    assert.equal(await side(), before.side, "no job, import, label, asset or dataset row was added or removed");
    if (phase === "final") {
      await assert.rejects(db.dataset.update({ where: { id: "mn-a-image" }, data: { modality: "VIDEO" } }), /DATASET_MODALITY_IMMUTABLE/);
      await assert.rejects(db.dataset.update({ where: { id: "mn-a-image" }, data: { modalityResolverSubject: "system:phase029-backfill:forged-token" } }), /DATASET_MODALITY_IMMUTABLE/);
      assert.equal((await db.dataset.findUniqueOrThrow({ where: { id: "mn-p-unapproved" } })).modality, null, "the unapproved dataset was never mutated");
    }
  } finally { await db.$disconnect(); }
});
