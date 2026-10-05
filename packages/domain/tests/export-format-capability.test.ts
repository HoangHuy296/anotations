import assert from "node:assert/strict";
import test from "node:test";

import { EXPORT_FORMAT_CAPABILITY, checkFormatCompatibility, isFormatSelectable, selectableFormatsByModality } from "../src/export-format-capability.js";

test("JSON and COCO are selectable; VOC/LABELME/CVAT/OPENIMAGES/MOT are not yet (implemented=false)", () => {
  assert.equal(isFormatSelectable("JSON"), true);
  assert.equal(isFormatSelectable("COCO"), true);
  assert.equal(isFormatSelectable("YOLO"), true);
  for (const format of ["VOC", "LABELME", "CVAT", "OPENIMAGES", "MOT"] as const) {
    assert.equal(isFormatSelectable(format), false, `${format} must not be selectable yet`);
  }
});

test("MOT is deferred, not implemented, and carries its FPS prerequisite as data, not a removed capability", () => {
  const mot = EXPORT_FORMAT_CAPABILITY.MOT;
  assert.equal(mot.implemented, false);
  assert.ok(mot.deferralReason, "MOT must state why it is deferred, not just silently absent");
  assert.deepEqual(mot.prerequisites, [{ kind: "CANONICAL_VIDEO_FPS", field: "VideoAsset.fps", skipReasonWhenMissing: "missing_fps" }]);
  assert.deepEqual(mot.modalities, ["VIDEO"]);
});

test("aiozVerified is true only for COCO; every other format is explicitly unverified", () => {
  assert.equal(EXPORT_FORMAT_CAPABILITY.COCO.aiozVerified, true);
  for (const [format, capability] of Object.entries(EXPORT_FORMAT_CAPABILITY)) {
    if (format === "COCO") continue;
    assert.equal(capability.aiozVerified, false, `${format} must not claim AIOZ verification`);
  }
});

test("checkFormatCompatibility: a pure-IMAGE target is compatible with YOLO/COCO/JSON", () => {
  assert.deepEqual(checkFormatCompatibility("YOLO", ["IMAGE"]), { ok: true });
  assert.deepEqual(checkFormatCompatibility("COCO", ["IMAGE"]), { ok: true });
  assert.deepEqual(checkFormatCompatibility("JSON", ["IMAGE"]), { ok: true });
});

test("checkFormatCompatibility: a mixed-modality target is rejected outright for YOLO, never partially exported", () => {
  const result = checkFormatCompatibility("YOLO", ["IMAGE", "VIDEO"]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "UNSUPPORTED_MODALITY");
    assert.equal(result.unsupportedModality, "VIDEO");
  }
});

test("checkFormatCompatibility: JSON alone is compatible with a mixed-modality target (covers every modality)", () => {
  assert.deepEqual(checkFormatCompatibility("JSON", ["IMAGE", "VIDEO", "AUDIO", "TEXT"]), { ok: true });
});

test("checkFormatCompatibility: a not-yet-implemented format is rejected as NOT_IMPLEMENTED, even for a compatible modality", () => {
  const result = checkFormatCompatibility("VOC", ["IMAGE"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "NOT_IMPLEMENTED");
});

test("checkFormatCompatibility: an empty modality set (no assets) is always compatible -- nothing to conflict with", () => {
  assert.deepEqual(checkFormatCompatibility("YOLO", []), { ok: true });
});

test("selectableFormatsByModality groups only currently-selectable formats, never a hard-coded list", () => {
  const grouped = selectableFormatsByModality();
  assert.deepEqual(grouped.IMAGE.sort(), ["COCO", "JSON", "YOLO"].sort());
  assert.deepEqual(grouped.VIDEO, ["JSON"]); // MOT excluded -- not selectable
  assert.deepEqual(grouped.AUDIO, ["JSON"]);
  assert.deepEqual(grouped.TEXT, ["JSON"]);
});
