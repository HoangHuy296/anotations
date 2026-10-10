import { createHash } from "node:crypto";

const round = (value: number) => Math.round(value * 1e6) / 1e6;
type Box = { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null | undefined;
const boxKey = (box: Box) => [box?.x, box?.y, box?.width, box?.height].map((v) => (typeof v === "number" ? round(v) : "n")).join(",");

/**
 * Deterministic identity of one provider result (a video track with its observed keyframes, or one image detection). It is stored in `properties`
 * so a repeated AI task over the same asset with the same model and an identical result is recognised and skipped instead of duplicated. The class
 * key is part of the identity; the label a human later assigned is deliberately not, so edited/relabeled rows still count as "already persisted".
 */
export function aiResultFingerprint(input: { modelKey: string | null; assetId: string; classKey: string; providerTrackId?: number; frames: Array<{ frameIndex?: number; box: Box }> }): string {
  const canonical = JSON.stringify([input.modelKey ?? "", input.assetId, input.classKey, input.providerTrackId ?? null, input.frames.map((f) => `${f.frameIndex ?? ""}:${boxKey(f.box)}`)]);
  return createHash("sha256").update(canonical).digest("hex");
}
