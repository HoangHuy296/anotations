import assert from "node:assert/strict";
import test from "node:test";

import { DatasetMemberRole, JobType, UserRole } from "@internal/db";

import { readAuthorizedExportJob } from "@/lib/exports/authorization";
import { db } from "@/lib/db";
import { exportRequestSchema } from "@/lib/validation/export";
import { createJobQueueFixture } from "./helpers";

test("export request accepts only the canonical metadata-only JSON configuration", () => {
  assert.deepEqual(exportRequestSchema.parse({ datasetId: "cm12345678901234567890123" }), {
    datasetId: "cm12345678901234567890123", format: "JSON", manifestSchemaVersion: "1",
  });
  for (const input of [
    {},
    { datasetId: "bad" },
    { datasetId: "cm12345678901234567890123", format: "ZIP" },
    { datasetId: "cm12345678901234567890123", manifestSchemaVersion: "2" },
    { datasetId: "cm12345678901234567890123", storageKey: "private" },
    { datasetId: "cm12345678901234567890123", input: { manifest: [] } },
  ]) assert.equal(exportRequestSchema.safeParse(input).success, false);
});

const integrationEnabled = process.env.EXPORT_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("export authorization conceals non-members and forbids a known member without permission", { skip: !integrationEnabled }, async () => {
  const fixture = await createJobQueueFixture();
  try {
    const labeler = await db.user.findUniqueOrThrow({ where: { id: fixture.labeler.id }, select: { id: true, email: true, name: true, role: true } });
    const outsider = await db.user.findUniqueOrThrow({ where: { id: fixture.outsider.id }, select: { id: true, email: true, name: true, role: true } });
    const job = await fixture.createJob({ type: JobType.EXPORT_DATASET });
    const labelerActor = { ...labeler, name: labeler.name ?? labeler.email, role: UserRole.LABELER };
    const outsiderActor = { ...outsider, name: outsider.name ?? outsider.email, role: UserRole.LABELER };
    assert.deepEqual(await readAuthorizedExportJob(labelerActor, job.id, "job.createExport"), { ok: false, status: 403 });
    assert.deepEqual(await readAuthorizedExportJob(outsiderActor, job.id), { ok: false, status: 404 });
    assert.equal(await db.datasetMember.count({ where: { datasetId: fixture.datasetId, userId: fixture.labeler.id, role: DatasetMemberRole.LABELER } }), 1);
  } finally { await fixture.cleanup(); }
});
