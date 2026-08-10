import { Badge } from "@/components/ui/badge";
import type { Modality } from "@internal/db";

const labelByEngine: Record<Exclude<Modality, "IMAGE">, string> = {
  VIDEO: "Video",
  AUDIO: "Audio",
  TEXT: "Text",
};

/**
 * VIDEO/AUDIO/TEXT's shared-status-surface content until spec User Story 8
 * (VIDEO) adds real per-modality fields (current frame, timestamp, playback
 * speed, latency, etc., per FR-037). Shows the modality badge only, matching
 * IMAGE's current baseline content.
 */
export function PlaceholderStatusFields({ engine }: { engine: Exclude<Modality, "IMAGE"> }) {
  return <Badge variant="neutral">{labelByEngine[engine]}</Badge>;
}
