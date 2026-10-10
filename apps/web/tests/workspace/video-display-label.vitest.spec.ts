import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { describe, expect, it } from "vitest";

import { aiClassColor, recordedAiClass, resolveDisplayLabel, UNLABELED_TEXT } from "@/lib/workspace/video-display-label";

const person = { name: "person", color: "#ff99fc", modality: "VIDEO", scope: "OBJECT" };

describe("VIDEO display label resolution (assigned label > matching dataset label > original AI class > unlabeled)", () => {
  it("A/B/C: a class with no Label row is displayed exactly as the AI Service returned it, with a stable colour, and creates nothing", () => {
    for (const cls of ["person", "motorcycle", "sports ball"]) {
      const d = resolveDisplayLabel({ assigned: null, trackProperties: { predictedClass: cls }, datasetLabels: [] });
      expect(d).toMatchObject({ text: cls, source: "AI_CLASS", predictedClass: cls });
      expect(d.color).toBe(aiClassColor(cls));
    }
    expect(aiClassColor("person")).toBe(aiClassColor("person"));
  });

  it("the original spelling is preserved (display), while matching uses the canonical key", () => {
    expect(resolveDisplayLabel({ assigned: null, trackProperties: { predictedClass: "  Sports Ball " }, datasetLabels: [] })).toMatchObject({ text: "Sports Ball", source: "AI_CLASS" });
  });

  it("D: an existing compatible dataset label with that canonical name is shown (its own name and colour), with no assignment needed", () => {
    expect(resolveDisplayLabel({ assigned: null, trackProperties: { predictedClass: "Person" }, datasetLabels: [person] })).toMatchObject({ text: "person", color: "#ff99fc", source: "DATASET_LABEL", predictedClass: "Person" });
    expect(resolveDisplayLabel({ assigned: null, trackProperties: { predictedClass: "person" }, datasetLabels: [{ ...person, modality: null }] }).source).toBe("DATASET_LABEL");
  });

  it("E: an explicitly assigned label always wins, and the original AI class stays available as metadata", () => {
    const d = resolveDisplayLabel({ assigned: { name: "pedestrian", color: "#123456" }, trackProperties: { predictedClass: "person" }, datasetLabels: [person] });
    expect(d).toMatchObject({ text: "pedestrian", color: "#123456", source: "ASSIGNED", predictedClass: "person" });
  });

  it("an incompatible same-name label (IMAGE-only, or non-OBJECT scope) is never used; the original AI class is still shown", () => {
    for (const label of [{ ...person, modality: "IMAGE" }, { ...person, scope: "CLASSIFICATION" }]) {
      expect(resolveDisplayLabel({ assigned: null, trackProperties: { predictedClass: "person" }, datasetLabels: [label] })).toMatchObject({ text: "person", source: "AI_CLASS" });
    }
  });

  it("no fuzzy matching: a near-miss name is not matched", () => {
    expect(resolveDisplayLabel({ assigned: null, trackProperties: { predictedClass: "persons" }, datasetLabels: [person] })).toMatchObject({ text: "persons", source: "AI_CLASS" });
    expect(resolveDisplayLabel({ assigned: null, trackProperties: { predictedClass: "traffic light" }, datasetLabels: [{ ...person, name: "traffic-light" }] }).source).toBe("AI_CLASS");
  });

  it("I: a legacy AI row (labelId null, class only on the keyframe or only on the track) renders without any repair", () => {
    expect(resolveDisplayLabel({ assigned: null, trackProperties: {}, keyframeProperties: { predictedClass: "dog" }, datasetLabels: [] })).toMatchObject({ text: "dog", source: "AI_CLASS" });
    expect(resolveDisplayLabel({ assigned: null, trackProperties: { predictedClass: "dog" }, keyframeProperties: {}, datasetLabels: [] })).toMatchObject({ text: "dog", source: "AI_CLASS" });
    expect(recordedAiClass({ predictedClass: "x".repeat(300) }, { predictedClass: "ok" })).toMatchObject({ display: "ok" });
  });

  it("`unlabeled` appears only when there is no assigned label, no matching label and no usable class", () => {
    for (const properties of [undefined, null, {}, { predictedClass: "" }, { predictedClass: "unknown" }, { predictedClass: 5 }, { predictedClass: "bad\u0000" }]) {
      expect(resolveDisplayLabel({ assigned: null, trackProperties: properties, datasetLabels: [person] })).toMatchObject({ text: UNLABELED_TEXT, source: "NONE", color: null });
    }
  });
});
