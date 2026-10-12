import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AudioToolbox } from "@/components/workspace/audio-toolbox";
import { AUDIO_ANNOTATION_EDITING_AVAILABLE, AUDIO_ANNOTATION_GATE_REASON, AUDIO_GATED_ANNOTATION_TOOLS, audioToolGate } from "@/lib/workspace/audio-tool-capabilities";

const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("AUDIO annotation capability state", () => {
  it("states that AUDIO annotation editing is unavailable and gates every annotation tool with the reason", () => {
    expect(AUDIO_ANNOTATION_EDITING_AVAILABLE).toBe(false);
    expect([...AUDIO_GATED_ANNOTATION_TOOLS]).toEqual(["timesegmentaudio", "timestampaudio", "speakerlabel"]);
    for (const tool of AUDIO_GATED_ANNOTATION_TOOLS) expect(audioToolGate(tool)).toEqual({ disabled: true, reason: AUDIO_ANNOTATION_GATE_REASON });
    expect(AUDIO_ANNOTATION_GATE_REASON).toMatch(/Not available yet/);
    expect(audioToolGate("select")).toEqual({ disabled: false, reason: undefined });
  });

  it("renders Time Segment, Timestamp Label and Speaker disabled with the reason and no handler, plus an explicit playback-and-properties-only note", () => {
    const html = renderToStaticMarkup(<AudioToolbox />);
    for (const label of ["Time Segment", "Timestamp Label", "Speaker"]) {
      const tag = button(html, label);
      expect(tag, label).toMatch(/\sdisabled=""/);
      expect(tag, label).toContain('aria-disabled="true"');
      expect(tag, label).toContain(`title="${AUDIO_ANNOTATION_GATE_REASON}"`);
      expect(tag, label).not.toContain("aria-pressed");
    }
    expect(html).toMatch(/Playback and properties only/);
    expect(html.match(/<button/g)?.length).toBe(5); // 3 gated tools + the 2 existing read-only mask placeholders; nothing is offered as a working action
    expect([...html.matchAll(/<button[^>]*>/g)].every((match) => /\sdisabled=""/.test(match[0]))).toBe(true);
  });

  it("source contract: the gated tools have no click handler, never call setTool, and cannot start a write", () => {
    const toolbox = source("components/workspace/audio-toolbox.tsx");
    expect(toolbox).not.toMatch(/onClick|setTool|useAnnotationStore|fetch\(|persist|scheduleAutosave/);
    const engine = source("components/workspace/audio-engine.tsx");
    expect(engine).toMatch(/Audio annotation editing is intentionally unavailable/);
    expect(engine).not.toMatch(/putAssetAnnotations|scheduleAutosave|persist/);
  });
});
