import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RegistrationNotSanctionedError, SANCTIONED_AIOZ_REGISTRATION, requireSanctionedRegistration } from "../../register-aioz-model-scope.ts";

const KEY = "68d7f474-6982-446c-8c5a-121d56d12dc9";
// Offline: run with `node --import tsx --test scripts/db-safety/tests/register-aioz-model.test.mjs`. The receipt-bound runtime proof is scripts/mvp/aioz-registration-g1.mjs.
test("the sanctioned scope is exactly one provider model with fixed capability", () => {
  assert.deepEqual({ ...SANCTIONED_AIOZ_REGISTRATION }, { provider: "aioz-company", key: KEY, displayName: "YOLO26s_COCO", modality: "IMAGE", taskType: "DETECTION" });
  assert.equal(requireSanctionedRegistration(["--apply", KEY, "YOLO26s_COCO"]).key, KEY);
});

test("any other uuid, name, flag or extra argument is refused", () => {
  for (const args of [["--apply", "11111111-1111-4111-8111-111111111111", "YOLO26s_COCO"], ["--apply", KEY, "Other"], ["--apply", KEY], ["--apply"], [], ["--dry", KEY, "YOLO26s_COCO"], ["--apply", KEY, "YOLO26s_COCO", "x"], ["--apply", KEY.toUpperCase(), "YOLO26s_COCO"]]) {
    assert.throws(() => requireSanctionedRegistration(args), RegistrationNotSanctionedError);
  }
});

test("the catalog entry is pinned, and the entrypoint has the standard receipt gate (no deny-entry, no bare import)", () => {
  const catalog = JSON.parse(readFileSync(new URL("../commands.json", import.meta.url), "utf8"));
  assert.deepEqual(catalog["seed:register-aioz-model:yolo26s-coco"], { kind: "seed", cwd: ".", args: ["--import", "tsx", "scripts/register-aioz-model.ts", "--apply", KEY, "YOLO26s_COCO"] });
  const source = readFileSync(new URL("../../register-aioz-model.ts", import.meta.url), "utf8");
  assert.match(source.split("\n")[0], /^import "\.\/db-safety\/test-entry\.cjs";/);
  assert.equal(source.includes("deny-entry"), false);
});

const TRACK_KEY = "cb29e022-1ba7-4349-9dce-4fb3074e84d6";
test("the second sanctioned model is exactly ByteTrack VIDEO/TRACKING; models cannot be mixed or widened", async () => {
  const { SANCTIONED_AIOZ_REGISTRATIONS, SANCTIONED_AIOZ_TRACKING_REGISTRATION } = await import("../../register-aioz-model-scope.ts");
  assert.deepEqual({ ...SANCTIONED_AIOZ_TRACKING_REGISTRATION }, { provider: "aioz-company", key: TRACK_KEY, displayName: "ByteTrack YOLOX_S COCO", modality: "VIDEO", taskType: "TRACKING" });
  assert.equal(SANCTIONED_AIOZ_REGISTRATIONS.length, 2);
  assert.equal(requireSanctionedRegistration(["--apply", TRACK_KEY, "ByteTrack YOLOX_S COCO"]).taskType, "TRACKING");
  for (const args of [["--apply", TRACK_KEY, "YOLO26s_COCO"], ["--apply", KEY, "ByteTrack YOLOX_S COCO"], ["--apply", TRACK_KEY], ["--apply", TRACK_KEY, "ByteTrack YOLOX_S COCO", "x"], ["--apply", TRACK_KEY.toUpperCase(), "ByteTrack YOLOX_S COCO"]]) {
    assert.throws(() => requireSanctionedRegistration(args), RegistrationNotSanctionedError);
  }
  const catalog = JSON.parse(readFileSync(new URL("../commands.json", import.meta.url), "utf8"));
  assert.deepEqual(catalog["seed:register-aioz-model:bytetrack-yolox-s-coco"], { kind: "seed", cwd: ".", args: ["--import", "tsx", "scripts/register-aioz-model.ts", "--apply", TRACK_KEY, "ByteTrack YOLOX_S COCO"] });
});
