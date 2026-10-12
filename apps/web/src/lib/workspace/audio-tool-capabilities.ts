import type { AudioAnnotationTool } from "@/types/annotation";

/**
 * AUDIO annotation editing does not exist in this phase: there is no AUDIO annotation validation schema, service, API route or persistence contract (see
 * specs/029-modality-specific-datasets/contracts/audio-annotation-proposal.md), and `AudioEngine` says so ("Audio annotation editing is intentionally unavailable").
 * Every annotation tool is therefore gated with an accurate reason instead of looking usable and doing nothing. Playback, the properties panel and the description
 * autosave are separate, working capabilities and are NOT gated. Lifting a gate requires the approved AUDIO contract, not a UI change.
 */
export const AUDIO_ANNOTATION_EDITING_AVAILABLE = false;
export const AUDIO_GATED_ANNOTATION_TOOLS = ["timesegmentaudio", "timestampaudio", "speakerlabel"] as const satisfies readonly AudioAnnotationTool[];
export const AUDIO_ANNOTATION_GATE_REASON = "Not available yet: AUDIO annotation editing needs an approved annotation contract. Playback and properties work.";

export function audioToolGate(tool: AudioAnnotationTool): { disabled: boolean; reason: string | undefined } {
  const gated = !AUDIO_ANNOTATION_EDITING_AVAILABLE && (AUDIO_GATED_ANNOTATION_TOOLS as readonly AudioAnnotationTool[]).includes(tool);
  return { disabled: gated, reason: gated ? AUDIO_ANNOTATION_GATE_REASON : undefined };
}
