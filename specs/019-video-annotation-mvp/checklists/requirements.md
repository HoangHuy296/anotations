# Requirements Checklist: Video Annotation MVP

**Purpose**: Verify the Phase 019 specification is complete before planning.
**Created**: 2026-07-29  
**Feature**: [spec.md](../spec.md)

## Repository and architecture

- [ ] CHK001 Current `VideoObjectTrack`, `Annotation`, `VideoAsset`, and exact `AnnotationType` values are audited.
- [ ] CHK002 No replacement VideoTrack, VideoKeyframe, or VideoTemporalLabel model is proposed.
- [ ] CHK003 Shared workspace route, modality engine selection, PostgreSQL authority, private MinIO, and exact `{ jobId }` queue contract are preserved.
- [ ] CHK004 Migration/backfill impact is identified without creating a migration during specification.

## Revision and persistence

- [ ] CHK005 Track/keyframe mutations use only `VideoObjectTrack.revision`.
- [ ] CHK006 Standalone temporal-label mutations use only `Annotation.revision`.
- [ ] CHK007 Every successful mutation increments its owning revision exactly once in one atomic transaction.
- [ ] CHK008 Track/timestamp uniqueness, indexes, same-Dataset relationships, and deletion behavior are audited.
- [ ] CHK009 Interpolated geometry is derived and never persisted as an Annotation row.

## Validation and security

- [ ] CHK010 Timestamp, normalized bounding-box, temporal interval, property, and bounded-read validation is specified.
- [ ] CHK011 Foreign, malformed, unknown, cross-Dataset, non-VIDEO, stale, and duplicate requests have safe outcomes and no side effects.
- [ ] CHK012 Responses and UI projections exclude credentials, storage identity, provider/raw errors, queue internals, and filesystem paths.
- [ ] CHK013 Normal opaque-cookie authentication and existing permission matrix remain authoritative.

## User experience and tests

- [ ] CHK014 Video playback, timeline, track/keyframe, temporal-label, interpolation, autosave, and conflict behavior are independently testable.
- [ ] CHK015 Long-video reads are bounded by pagination or a time-window.
- [ ] CHK016 Regression coverage preserves Image Phase 017, Audio, imports, local-folder, and queue behavior.
- [ ] CHK017 Success criteria are measurable and completion requires reload persistence plus revision-conflict evidence.

## Shared workspace architecture

- [ ] CHK018 `WorkspaceEngine` is confirmed as the only component switching on `Asset.modality`/`WorkspaceSelection.engine` (via the registry lookup, not an inline `switch`).
- [ ] CHK019 `DatasetSidebar`, `PropertiesPanel`, and the shared status surface are each exactly one component, with no per-modality variant introduced.
- [ ] CHK020 `VideoEngine`'s inline track toolbar, Video Details, temporal-label list, and save-state footer are relocated to `DatasetSidebar`/`PropertiesPanel`/the shared status surface without changing track/keyframe/temporal-label data flow or revision contracts (FR-005–FR-030).
- [ ] CHK021 The relocation is confirmed behavior-preserving for IMAGE, with existing Image tests remaining green.
- [ ] CHK022 The route discrepancy between Feature overview's `/workspace/[datasetId]` query-parameter route and any prior path-segment claim is resolved in the spec text.
- [ ] CHK023 A single shared workspace registry (FR-041–FR-044) exists, keyed by `engine`, holding each modality's Engine component, toolbox, tabs, and status-field specifications, with no duplicate mapping elsewhere.
- [ ] CHK024 A synthetic fifth registry entry can be added and removed with changes confined to the registry module (SC-011).
- [ ] CHK025 The registry is confirmed to be a static, closed-union TypeScript mapping — not a runtime/dynamic/third-party plugin system (Known limitations).

## Interaction ownership

- [ ] CHK026 The native `<video>` element is confirmed renderer-only in annotation mode — no native controls, no click-to-play/pause, no native seek-bar drag, no double-click fullscreen, no touch-gesture playback (FR-045).
- [ ] CHK027 The annotation overlay/canvas is confirmed the exclusive pointer-interaction layer for create/select/drag/resize/vertex-edit, for pointer/mouse/touch alike, without relying on `stopPropagation()` alone (FR-046).
- [ ] CHK028 Playback (play/pause/seek/frame-step) is confirmed to go only through one shared workspace playback authority reachable only from the timeline/toolbar — no annotation component drives playback directly (FR-047).
- [ ] CHK029 Frame navigation is confirmed deterministic (one actual-fps frame per step, not an arbitrary millisecond increment) and updates current-time, current-frame state, visible annotations/interpolation, and the timeline playhead together (FR-048).
- [ ] CHK030 Beginning an annotation interaction is confirmed to pause active playback and hold the frame fixed; completing it is confirmed to leave playback paused, not auto-resume (FR-049).
- [ ] CHK031 Timeline pointer interaction is confirmed to have its own event boundary and never creates/moves/deletes an annotation as a side effect (FR-050).
- [ ] CHK032 "Existing track → Add keyframe here" is confirmed to create exactly one keyframe on the existing `VideoObjectTrack` — never a new track — with independent geometry per keyframe (FR-051, reaffirming FR-008/FR-022).
- [ ] CHK033 No new video-provider dependency (Video.js, Plyr, or similar) is introduced; the native `<video>` element remains the decoder/renderer (Explicit non-goals).

## Notes

This checklist is intentionally unchecked because it gates implementation
planning and execution; checking items requires repository and runtime evidence.
