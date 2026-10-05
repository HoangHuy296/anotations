import { describe, expect, it } from "vitest";

import { addConfirmedClass, removeConfirmedClass, validateClassName } from "@/lib/imports/confirmed-classes";
import { creationModalities, maintainedRecommendedClasses, recommendedClassNames } from "@/lib/imports/recommended-classes";
import { normalizeLabelName } from "@/lib/validation/label";

describe("maintained recommendation boundary", () => {
  it("has no approved defaults: every modality returns the explicit none source with no classes", () => {
    for (const modality of creationModalities) {
      const source = maintainedRecommendedClasses(modality);
      expect(source).toEqual({ status: "none" });
      expect(recommendedClassNames(source)).toEqual([]);
    }
    expect(maintainedRecommendedClasses("")).toEqual({ status: "none" });
  });
  it("carries provenance for a future maintained source without changing the confirmed-class contract", () => {
    expect(recommendedClassNames({ status: "maintained", provenance: "approved-defaults-v1", classes: ["car"] })).toEqual(["car"]);
  });
});

describe("confirmed class draft", () => {
  it("applies the existing Label name rule (trimmed, 2-50 characters)", () => {
    expect(validateClassName("  car  ")).toEqual({ ok: true, name: "car" });
    expect(validateClassName("a").ok).toBe(false);
    expect(validateClassName("   ").ok).toBe(false);
    expect(validateClassName("x".repeat(50)).ok).toBe(true);
    expect(validateClassName("x".repeat(51)).ok).toBe(false);
  });
  it("adds classes in entry order and trims", () => {
    const first = addConfirmedClass([], " Car ");
    expect(first).toMatchObject({ ok: true, classes: ["Car"], name: "Car" });
    const second = addConfirmedClass(first.ok ? first.classes : [], "bus");
    expect(second.ok && second.classes).toEqual(["Car", "bus"]);
  });
  it("rejects duplicates by the existing Label identity (normalizeLabelName) and keeps the list unchanged", () => {
    expect(normalizeLabelName("Car")).toBe(normalizeLabelName(" car "));
    const result = addConfirmedClass(["Car"], " car ");
    expect(result).toMatchObject({ ok: false, reason: "DUPLICATE" });
  });
  it("rejects invalid names with the existing rule's message", () => {
    const result = addConfirmedClass(["Car"], "a");
    expect(result).toMatchObject({ ok: false, reason: "INVALID", message: "Name must contain at least 2 characters." });
  });
  it("removes by normalized identity and never mutates its input", () => {
    const list = ["Car", "Bus"] as const;
    expect(removeConfirmedClass(list, "car")).toEqual(["Bus"]);
    expect(list).toEqual(["Car", "Bus"]);
  });
});
