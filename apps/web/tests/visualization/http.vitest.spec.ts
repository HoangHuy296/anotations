import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { RequestActor } from "@/lib/auth";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), getObject: vi.fn(), statObject: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getRequestActor: mocks.actor }));
vi.mock("@/lib/providers", () => ({ getWebProviders: () => ({ minio: { getObject: mocks.getObject, statObject: mocks.statObject } }) }));
import { db } from "@/lib/db";
import { GET as datasetGet } from "@/app/api/datasets/[datasetId]/visualization/route";
import { GET as assetsGet } from "@/app/api/datasets/[datasetId]/visualization/assets/route";
import { GET as assetGet } from "@/app/api/datasets/[datasetId]/visualization/assets/[assetId]/route";
import { GET as mediaGet } from "@/app/api/datasets/[datasetId]/visualization/assets/[assetId]/media/route";
import { GET as insightsGet } from "@/app/api/datasets/[datasetId]/visualization/insights/route";
import { GET as schemaGet } from "@/app/api/datasets/[datasetId]/visualization/schema/route";
import { GET as activityGet } from "@/app/api/datasets/[datasetId]/visualization/activity/route";

import { GET as versionsGet } from "@/app/api/datasets/[datasetId]/visualization/versions/route";
import { GET as derivedGet } from "@/app/api/datasets/[datasetId]/visualization/derived/route";
import { GET as snapshotGet } from "@/app/api/datasets/[datasetId]/visualization/versions/[snapshotId]/route";
import { GET as artifactGet } from "@/app/api/datasets/[datasetId]/visualization/artifacts/[artifactId]/route";
const snapshotId = `vs_${"1".repeat(64)}`;
const artifactId = `va_${"2".repeat(64)}`;
const snapshotHandler: typeof datasetGet = (request, context) => snapshotGet(request, { params: context.params.then(p => ({ ...p, snapshotId })) });
const artifactHandler: typeof datasetGet = (request, context) => artifactGet(request, { params: context.params.then(p => ({ ...p, artifactId })) });

let actor: RequestActor;
let datasetId: string;
let otherDatasetId: string;
let assetId: string;
let otherAssetId: string;
let videoId: string;
let missingId: string;
let labelId: string;
let annotationId: string;
let jobId: string;
const handlers = [datasetGet, assetsGet, assetGet, mediaGet, insightsGet, schemaGet, activityGet, versionsGet, derivedGet, snapshotHandler, artifactHandler];
const call = (handler: typeof datasetGet, query = "", id = assetId) => handler(new Request(`http://localhost/api/datasets/${datasetId}/visualization${query}`), { params: Promise.resolve({ datasetId, assetId: id }) });

beforeAll(async () => {
  const user = await db.user.create({ data: { email: `vis3-${randomUUID()}@test.invalid`, name: "Viewer tester", role: "MANAGER" } });
  actor = { ...user, name: user.name! }; mocks.actor.mockResolvedValue(actor);
  const dataset = await db.dataset.create({ data: { ownerId: user.id, name: "Real completed fixture", metadata: { workflowStatus: "COMPLETED", privateUrl: "must-not-leak" } } }); datasetId = dataset.id;
  otherDatasetId = (await db.dataset.create({ data: { ownerId: user.id, name: "Other" } })).id;
  const image = await db.asset.create({ data: { datasetId, modality: "IMAGE", filename: "a.jpg", mimeType: "image/jpeg", width: 1000, height: 500, sourceFingerprint: randomUUID(), storageProvider: "MINIO", storageBucket: "private-bucket", storageKey: randomUUID(), metadata: { secret: "must-not-leak" } } }); assetId = image.id;
  videoId = (await db.asset.create({ data: { datasetId, modality: "VIDEO", filename: "b.mp4", mimeType: "video/mp4", sourceFingerprint: randomUUID() } })).id;
  missingId = (await db.asset.create({ data: { datasetId, modality: "IMAGE", filename: "c.png", mimeType: "image/png", sourceFingerprint: randomUUID() } })).id;
  otherAssetId = (await db.asset.create({ data: { datasetId: otherDatasetId, modality: "IMAGE", filename: "other.png", mimeType: "image/png", sourceFingerprint: randomUUID() } })).id;
  labelId = (await db.label.create({ data: { datasetId, name: "Car", normalizedName: "car", color: "#12abef" } })).id;
  annotationId = (await db.annotation.create({ data: { datasetId, assetId, createdById: user.id, modality: "IMAGE", type: "BOUNDING_BOX", labelId, geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } } })).id;
  jobId = (await db.job.create({ data: { datasetId, createdById: user.id, type: "IMPORT_DATASET", input: { secret: "must-not-leak" } } })).id;
  mocks.statObject.mockResolvedValue({ size: 3 }); mocks.getObject.mockImplementation(async () => Readable.from(Buffer.from([1, 2, 3])));
});
afterAll(async () => {
  if (datasetId) await db.dataset.deleteMany({ where: { id: { in: [datasetId, otherDatasetId] } } });
  if (actor) await db.user.delete({ where: { id: actor.id } });
});

test("thin projections preserve real IDs, label colors, pagination, filters, and unsupported modalities", async () => {
  const first = await (await call(assetsGet, "?pageSize=2")).json();
  expect(first.data.total).toBe(3); expect(first.data.items.map((x: { row_id: string }) => x.row_id)).toEqual([assetId, videoId]);
  expect(first.data.items[1].modality).toBe("VIDEO");
  const second = await (await call(assetsGet, "?pageSize=2&page=2")).json(); expect(second.data.items[0].row_id).toBe(missingId);
  const filtered = await (await call(assetsGet, `?labelId=${labelId}`)).json(); expect(filtered.data.total).toBe(1);
  const detail = await (await call(assetGet)).json();
  expect(detail.data.row_id).toBe(assetId); expect(detail.data.annotations[0]).toMatchObject({ id: annotationId, geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, label: { id: labelId, color: "#12abef" } });
  expect(JSON.stringify(detail)).not.toMatch(/storageBucket|storageKey|metadata|must-not-leak/);
  expect((await call(assetsGet, "?pageSize=51")).status).toBe(400);
  expect((await call(assetsGet, "?page=1&page=2")).status).toBe(400);
  expect((await call(assetGet, "", otherAssetId)).status).toBe(404);
  expect((await call(mediaGet, "", otherAssetId)).status).toBe(404);
});
test("safe real aggregates, labels, and durable Job summaries", async () => {
  const insights = await (await call(insightsGet)).json(); expect(insights.data).toMatchObject({ assetCount: 3, imageCount: 2, unsupportedCount: 1, annotationCount: 1, dimensions: { count: 1, minWidth: 1000 } });
  expect(insights.data.labelDistribution[0]).toMatchObject({ label: { id: labelId, color: "#12abef" }, count: 1 });
  const schema = await (await call(schemaGet)).json(); expect(schema.data.labels.items[0].id).toBe(labelId); expect(JSON.stringify(schema)).toContain("0..1");
  const activity = await (await call(activityGet)).json(); expect(activity.data.items[0].id).toBe(jobId); expect(JSON.stringify(activity)).not.toMatch(/input|must-not-leak/);
});
test("media is scoped, streamed without storage details and errors sanitized", async () => {
  const response = await call(mediaGet); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  expect((await call(mediaGet, "", missingId)).status).toBe(409);
  expect((await call(mediaGet, "", videoId)).status).toBe(415);
  mocks.getObject.mockRejectedValueOnce(new Error("private-bucket credentials"));
  const failed = await call(mediaGet); expect(failed.status).toBe(409); expect(await failed.text()).not.toContain("credentials");
});
test("oversized media is unavailable and reopening during media I/O discards the response", async () => {
  mocks.statObject.mockResolvedValueOnce({ size: 26 * 1024 * 1024 });
  expect((await call(mediaGet)).status).toBe(409);
  mocks.getObject.mockImplementationOnce(async () => {
    await db.dataset.update({ where: { id: datasetId }, data: { metadata: { workflowStatus: "IN_PROGRESS" } } });
    return Readable.from(Buffer.from([1, 2, 3]));
  });
  const response = await call(mediaGet);
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("DATASET_NOT_COMPLETED");
  await db.dataset.update({ where: { id: datasetId }, data: { metadata: { workflowStatus: "COMPLETED" } } });
});
test("every endpoint independently rejects reopening, missing session, outsider, archived/deleted datasets", async () => {
  for (const status of ["IN_PROGRESS", "REVIEWED", "DRAFT"]) {
    await db.dataset.update({ where: { id: datasetId }, data: { metadata: { workflowStatus: status } } });
    for (const handler of handlers) { const response = await call(handler); expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("DATASET_NOT_COMPLETED"); }
  }
  await db.dataset.update({ where: { id: datasetId }, data: { metadata: { workflowStatus: "COMPLETED" } } });
  mocks.actor.mockResolvedValue(null); for (const handler of handlers) expect((await call(handler)).status).toBe(401);
  mocks.actor.mockResolvedValue({ ...actor, id: "outsider" }); for (const handler of handlers) expect((await call(handler)).status).toBe(404);
  mocks.actor.mockResolvedValue(actor);
  for (const field of ["archivedAt", "deletedAt"]) {
    await db.dataset.update({ where: { id: datasetId }, data: { [field]: new Date() } });
    for (const handler of handlers) expect((await call(handler)).status).toBe(404);
    await db.dataset.update({ where: { id: datasetId }, data: { [field]: null } });
  }
});

test("snapshot/artifact endpoints allowlist results, reject cross-dataset IDs and reauthorize after I/O", async () => {
  const snapshot = await db.datasetSnapshot.create({ data: { id: snapshotId, datasetId, generation: BigInt(1), contentDigest: "a".repeat(64), algorithm: "capture-v1", ordinal: 1, assetCount: 1, annotationCount: 1 } });
  await db.visualizationArtifact.create({ data: { id: artifactId, datasetId, snapshotId: snapshot.id, kind: "SOURCE_IMAGE", algorithm: "capture-v1", scope: assetId, bucket: "private-bucket", key: randomUUID(), sha256: createHash("sha256").update(Buffer.from([1, 2, 3])).digest("hex"), sizeBytes: BigInt(3), contentType: "image/png" } });
  const versions = await (await call(versionsGet)).json(); expect(versions.data.total).toBe(1); expect(versions.data.items).toHaveLength(1);
  expect(JSON.stringify(versions)).not.toMatch(/bucket|storageKey|input|result|contentDigest/);
  expect((await call(artifactHandler)).status).toBe(200);
  expect((await artifactGet(new Request("http://localhost/"), { params: Promise.resolve({ datasetId: otherDatasetId, artifactId }) })).status).toBe(409);
  await db.dataset.update({ where: { id: otherDatasetId }, data: { metadata: { workflowStatus: "COMPLETED" } } });
  expect((await artifactGet(new Request("http://localhost/"), { params: Promise.resolve({ datasetId: otherDatasetId, artifactId }) })).status).toBe(404);
  expect((await snapshotGet(new Request("http://localhost/"), { params: Promise.resolve({ datasetId: otherDatasetId, snapshotId }) })).status).toBe(404);
  // Current actor authorization is checked again, including persisted ownership changes.
  mocks.getObject.mockReset(); mocks.getObject.mockImplementationOnce(async () => {
    await db.dataset.update({ where: { id: datasetId }, data: { metadata: { workflowStatus: "IN_PROGRESS" } } });
    return Readable.from(Buffer.from([1, 2, 3]));
  });
  expect((await call(artifactHandler)).status).toBe(409);
  await db.dataset.update({ where: { id: datasetId }, data: { metadata: { workflowStatus: "COMPLETED" } } });
  mocks.getObject.mockImplementation(async () => Readable.from(Buffer.from([1, 2, 3])));
  mocks.actor.mockResolvedValue({ ...actor, id: "revoked" });
  expect((await call(artifactHandler)).status).toBe(404); expect((await call(versionsGet)).status).toBe(404);
  mocks.actor.mockResolvedValue(actor);
});
