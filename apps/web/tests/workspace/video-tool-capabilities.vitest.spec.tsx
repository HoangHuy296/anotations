import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VideoToolbox } from "@/components/workspace/video-toolbox";
import { VIDEO_GATED_SHAPE_TOOLS, VIDEO_PERSISTED_SHAPE_TOOLS, VIDEO_SHAPE_GATE_REASON, videoShapeToolGate } from "@/lib/workspace/video-tool-capabilities";
import { videoTrackCreateSchema } from "@/lib/validation/video-annotation";

const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";

describe("VIDEO shape tool capability gate", () => {
  it("matches the persistence contract: only BOUNDING_BOX tracks are accepted, so only the box tool persists", () => {
    expect(videoTrackCreateSchema.safeParse({ annotationType: "BOUNDING_BOX" }).success).toBe(true);
    for (const type of ["POLYGON", "CIRCLE", "POINT", "POLYLINE"]) expect(videoTrackCreateSchema.safeParse({ annotationType: type }).success).toBe(false);
    expect(VIDEO_PERSISTED_SHAPE_TOOLS).toEqual(["box"]);
    expect([...VIDEO_GATED_SHAPE_TOOLS]).toEqual(["polygon", "circle", "point", "polyline"]);
    expect(videoShapeToolGate("box")).toEqual({ disabled: false, reason: undefined });
  });

  it("renders Polygon, Circle, Point and Polyline disabled with the contract reason, and keeps Bounding box usable", () => {
    const html = renderToStaticMarkup(<VideoToolbox />);
    for (const label of ["Polygon", "Circle", "Point", "Polyline"]) {
      const tag = button(html, label);
      expect(tag, label).toMatch(/\sdisabled=""/);
      expect(tag, label).toContain(`title="${VIDEO_SHAPE_GATE_REASON}"`);
    }
    for (const label of ["Select", "Bounding box", "Pan", "AI Tracking"]) expect(button(html, label), label).not.toMatch(/\sdisabled=""/);
  });
});
