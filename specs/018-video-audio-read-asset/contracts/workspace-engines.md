# Workspace Engine Contract

## Canonical selection boundary

The shared shell resolves and authorizes the selected Asset server-side, then
chooses one engine from `Asset.modality`:

```text
IMAGE → ImageEngine
VIDEO → VideoEngine
AUDIO → AudioEngine
TEXT  → TextEngine
```

This selection is never made inside ImageCanvas. A non-IMAGE Asset is never
passed to ImageEngine or ImageCanvas.

## Engine responsibilities

| Engine | Phase 018 responsibility |
|---|---|
| ImageEngine | Retain existing image canvas and supported shape tools; render masks/future shapes visibly read-only. |
| VideoEngine | Safe player capability, metadata, frame overlay, timeline/playback state, supported frame shapes, tracks, keyframes, interpolation, temporal labels, revision-safe autosave. |
| AudioEngine | Safe audio metadata, waveform readiness/display, Asset navigation, and explicit no-edit state. |
| TextEngine | Preserve an explicit safe unsupported/read-only state; it must not fall through to image UI. |

## Video durable-edit rules

- Frame shapes are Asset-scoped and use current frame/time data.
- Track/keyframe/temporal edits are authorized, revision guarded, and cannot
  cross Dataset/Asset boundaries.
- Geometry changes do not alter label taxonomy metadata.
- Autosave waits 1.5 seconds after inactivity and flushes before navigation.
- A revision conflict preserves the local draft and requires reconciliation;
  it is never silently retried.
- Mask editing is not implemented by this contract; show a visible placeholder.
