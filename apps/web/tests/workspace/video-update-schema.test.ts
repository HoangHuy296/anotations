import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { videoKeyframeUpdateSchema, videoTemporalLabelUpdateSchema, videoTrackCreateSchema, videoTrackUpdateSchema } from "@/lib/validation/video-annotation";

test("an update that does not mention `properties` leaves it undefined, so stored AI provenance is never overwritten with {}", () => {
  const track = videoTrackUpdateSchema.parse({ expectedTrackRevision: 1, labelId: "cmv2oz3le000mmn0kgxw78tu2" });
  assert.equal(track.properties, undefined);
  const keyframe = videoKeyframeUpdateSchema.parse({ expectedTrackRevision: 1, timestampMs: 100 });
  assert.equal(keyframe.properties, undefined);
  const temporal = videoTemporalLabelUpdateSchema.parse({ expectedRevision: 1, labelId: "cmv2oz3le000mmn0kgxw78tu2" } as never);
  assert.equal(temporal.properties, undefined);
});

test("an explicit properties object is still accepted on update, and creation keeps its {} default", () => {
  assert.deepEqual(videoTrackUpdateSchema.parse({ expectedTrackRevision: 1, properties: { note: "x" } }).properties, { note: "x" });
  assert.deepEqual(videoTrackCreateSchema.parse({ annotationType: "BOUNDING_BOX" } as never).properties, {});
});

test("an empty keyframe update is rejected again (the default no longer defeats the emptiness check)", () => {
  assert.equal(videoKeyframeUpdateSchema.safeParse({ expectedTrackRevision: 1 }).success, false);
});
